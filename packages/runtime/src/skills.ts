/** Skill v1: registry, filesystem source, progressive-disclosure loader and handler access. Never executes scripts. */
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import {
  basename,
  isAbsolute,
  join,
  normalize,
  relative,
  sep,
} from 'node:path';
import {
  AGENT_SKILLS_SPEC_VERSION,
  AgentropyError,
  enforcePolicy,
  validateSkillMetadata,
  type SkillAccess,
  type SkillLoader,
  type SkillMetadata,
  type SkillPin,
  type SkillRecord,
  type SkillRequirements,
  type TrustedPrincipal,
  type VersionedRef,
} from '@agentropy/core';
import semver from 'semver';
import { parse as parseYaml } from 'yaml';
import { recordAudit, type SecurityServices } from './tools.js';

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const SPEC_KEYS = [
  'name',
  'description',
  'license',
  'compatibility',
  'metadata',
] as const;

/** Parse SKILL.md into standard metadata and the Markdown body. Unknown frontmatter keys are ignored. */
export function parseSkillMd(text: string): {
  metadata: SkillMetadata;
  body: string;
} {
  const m = FRONTMATTER.exec(text);
  if (!m)
    throw new AgentropyError(
      'SchemaViolation',
      'SKILL.md must start with YAML frontmatter',
      { details: { what: 'SKILL.md', reason: 'frontmatter' } },
    );
  let raw: unknown;
  try {
    raw = parseYaml(m[1]!);
  } catch {
    throw new AgentropyError(
      'SchemaViolation',
      'SKILL.md frontmatter is not valid YAML',
      { details: { what: 'SKILL.md', reason: 'yaml' } },
    );
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new AgentropyError(
      'SchemaViolation',
      'SKILL.md frontmatter must be a mapping',
      { details: { what: 'SKILL.md' } },
    );
  const fm = raw as Record<string, unknown>;
  const candidate: Record<string, unknown> = {};
  for (const k of SPEC_KEYS) if (fm[k] !== undefined) candidate[k] = fm[k];
  const allowed = fm['allowed-tools'];
  if (allowed !== undefined)
    candidate.allowedTools =
      typeof allowed === 'string'
        ? allowed.split(/\s+/).filter(Boolean)
        : allowed;
  return {
    metadata: validateSkillMetadata(candidate),
    body: text.slice(m[0].length),
  };
}

/** Lists files (sorted, POSIX-style relative paths). Symlinks are refused: they can escape the skill root. */
async function listFiles(root: string, dir = root): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink())
      throw new AgentropyError(
        'PermissionDenied',
        'Skills may not contain symbolic links',
        { details: { reason: 'path' } },
      );
    if (entry.isDirectory()) out.push(...(await listFiles(root, full)));
    else if (entry.isFile())
      out.push(relative(root, full).split(sep).join('/'));
  }
  return out.sort((a, b) =>
    a === 'SKILL.md' ? -1 : b === 'SKILL.md' ? 1 : a.localeCompare(b),
  );
}

/** sha256 over every relative path and file content, in sorted order. */
export async function digestSkillDirectory(
  root: string,
): Promise<{ digest: string; files: string[] }> {
  const files = await listFiles(root);
  const hash = createHash('sha256');
  for (const f of files) {
    hash
      .update(f)
      .update('\0')
      .update(await readFile(join(root, f)))
      .update('\0');
  }
  return { digest: `sha256:${hash.digest('hex')}`, files };
}

export interface SkillRegistration {
  id?: string;
  version: string;
  requires?: SkillRequirements;
  publisher: string;
}

interface Entry {
  record: SkillRecord;
  root: string;
}

export class InMemorySkillRegistry {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly security: SecurityServices,
    private readonly verify: (
      metadata: SkillMetadata,
      publisher: string,
    ) => boolean,
  ) {}

  private async guard(
    admin: TrustedPrincipal,
    operation: string,
    id: string,
  ): Promise<void> {
    await enforcePolicy(this.security.pdp, {
      principal: admin,
      action: `skill-admin:${operation}`,
      resource: { type: 'skill', id, tenantId: admin.tenantId },
    });
    await recordAudit(this.security.audit, {
      type: `skill.${operation}`,
      tenantId: admin.tenantId,
      principalId: admin.id,
      action: `skill-admin:${operation}`,
      resource: { type: 'skill', id },
      decision: 'allow',
      at: this.security.now(),
    });
  }

  /** Register a skill directory in the standard format, without converting or rewriting it. */
  async register(
    directory: string,
    opts: SkillRegistration,
    admin: TrustedPrincipal,
  ): Promise<SkillRecord> {
    if (!semver.valid(opts.version))
      throw new AgentropyError(
        'SchemaViolation',
        'Skill version must be SemVer',
        { details: { what: 'SkillRegistration' } },
      );
    const root = await realpath(directory);
    let text: string;
    try {
      text = await readFile(join(root, 'SKILL.md'), 'utf8');
    } catch {
      throw new AgentropyError(
        'SchemaViolation',
        'Skill directory has no SKILL.md',
        { details: { what: 'SKILL.md', reason: 'missing' } },
      );
    }
    const { metadata } = parseSkillMd(text);
    if (metadata.name !== basename(root)) {
      throw new AgentropyError(
        'SchemaViolation',
        'Skill name must match its directory name',
        { details: { what: 'SKILL.md', reason: 'name-directory' } },
      );
    }
    const id = opts.id ?? metadata.name;
    const { digest, files } = await digestSkillDirectory(root);
    const key = `${id}@${opts.version}`;
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.record.digest === digest)
        return structuredClone(existing.record);
      throw new AgentropyError(
        'InvalidConfiguration',
        `${key} is already registered with different content`,
        { details: { reason: 'immutable', id } },
      );
    }
    await this.guard(admin, 'register', id);
    const record: SkillRecord = {
      id,
      version: opts.version,
      specVersion: AGENT_SKILLS_SPEC_VERSION,
      metadata,
      digest,
      provenance: {
        publisher: opts.publisher,
        source: root,
        verified: this.verify(metadata, opts.publisher),
      },
      requires: structuredClone(opts.requires ?? {}),
      files,
      status: 'registered',
      revision: 1,
    };
    this.entries.set(key, { record, root });
    return structuredClone(record);
  }

  async activate(
    ref: VersionedRef,
    admin: TrustedPrincipal,
  ): Promise<SkillRecord> {
    const e = this.require(ref);
    if (!e.record.provenance.verified)
      throw new AgentropyError(
        'PermissionDenied',
        'Unverified skills cannot be activated',
        { details: { reason: 'unverified' } },
      );
    if (e.record.status !== 'registered')
      throw new AgentropyError(
        'InvalidState',
        `Cannot activate a ${e.record.status} skill`,
        { details: { status: e.record.status } },
      );
    await this.guard(admin, 'activate', ref.id);
    e.record.status = 'active';
    e.record.revision += 1;
    return structuredClone(e.record);
  }

  async revoke(
    ref: VersionedRef,
    admin: TrustedPrincipal,
  ): Promise<SkillRecord> {
    const e = this.require(ref);
    if (e.record.status === 'revoked')
      throw new AgentropyError('InvalidState', 'Skill already revoked', {
        details: { status: 'revoked' },
      });
    await this.guard(admin, 'revoke', ref.id);
    e.record.status = 'revoked';
    e.record.revision += 1;
    return structuredClone(e.record);
  }

  get(ref: VersionedRef): SkillRecord | undefined {
    const e = this.entries.get(`${ref.id}@${ref.version}`);
    return e ? structuredClone(e.record) : undefined;
  }

  versions(id: string): SkillRecord[] {
    return [...this.entries.values()]
      .filter((e) => e.record.id === id)
      .map((e) => structuredClone(e.record));
  }

  /** Metadata-first discovery: never reads instructions or resources. */
  async discover(
    query: { text?: string },
    caller: TrustedPrincipal,
  ): Promise<Pick<SkillRecord, 'id' | 'version' | 'metadata'>[]> {
    void caller;
    const text = query.text?.toLowerCase();
    return [...this.entries.values()]
      .map((e) => e.record)
      .filter((r) => r.status !== 'revoked')
      .filter((r) =>
        text
          ? `${r.metadata.name} ${r.metadata.description}`
              .toLowerCase()
              .includes(text)
          : true,
      )
      .sort(
        (a, b) =>
          a.id.localeCompare(b.id) || semver.compare(a.version, b.version),
      )
      .map((r) => ({
        id: r.id,
        version: r.version,
        metadata: structuredClone(r.metadata),
      }));
  }

  /** Internal: root directory of a pinned, non-revoked skill. */
  rootFor(pin: SkillPin): { record: SkillRecord; root: string } {
    const e = this.require(pin);
    if (e.record.status === 'revoked')
      throw new AgentropyError(
        'PermissionDenied',
        `Skill ${pin.id} is revoked`,
        { details: { status: 'revoked' } },
      );
    if (e.record.digest !== pin.digest)
      throw new AgentropyError(
        'IncompatibleVersion',
        `Skill ${pin.id}@${pin.version} pin does not match the registry`,
        { details: { kind: 'skill' } },
      );
    return { record: e.record, root: e.root };
  }

  private require(ref: VersionedRef): Entry {
    const e = this.entries.get(`${ref.id}@${ref.version}`);
    if (!e)
      throw new AgentropyError(
        'NotFound',
        `Skill ${ref.id}@${ref.version} not found`,
        { details: { kind: 'skill' } },
      );
    return e;
  }
}

/** Filesystem loader with content verification on every load (progressive disclosure: metadata → body → resources). */
export class FileSystemSkillLoader implements SkillLoader {
  constructor(private readonly registry: InMemorySkillRegistry) {}

  async metadata(pin: SkillPin): Promise<SkillMetadata> {
    return structuredClone(this.registry.rootFor(pin).record.metadata);
  }

  async instructions(pin: SkillPin): Promise<string> {
    const { root } = await this.verified(pin);
    return parseSkillMd(await readFile(join(root, 'SKILL.md'), 'utf8')).body;
  }

  async resource(pin: SkillPin, relativePath: string): Promise<Uint8Array> {
    const safe = normalize(relativePath);
    if (
      !relativePath ||
      isAbsolute(relativePath) ||
      safe.split(/[\\/]/).includes('..') ||
      safe.startsWith(sep)
    ) {
      throw new AgentropyError(
        'PermissionDenied',
        'Skill resource path must stay inside the skill',
        { details: { reason: 'path' } },
      );
    }
    const { root, record } = await this.verified(pin);
    const rel = safe.split(sep).join('/');
    if (!record.files.includes(rel))
      throw new AgentropyError('NotFound', 'Skill resource not found', {
        details: { kind: 'skill-resource' },
      });
    const full = join(root, rel);
    if (
      (await lstat(full)).isSymbolicLink() ||
      !(await realpath(full)).startsWith(root + sep)
    ) {
      throw new AgentropyError(
        'PermissionDenied',
        'Skill resource path must stay inside the skill',
        { details: { reason: 'path' } },
      );
    }
    return new Uint8Array(await readFile(full));
  }

  private async verified(pin: SkillPin) {
    const resolved = this.registry.rootFor(pin);
    const { digest } = await digestSkillDirectory(resolved.root);
    if (digest !== pin.digest)
      throw new AgentropyError(
        'IncompatibleVersion',
        `Skill ${pin.id} content changed after pinning`,
        { details: { kind: 'skill' } },
      );
    return resolved;
  }
}

/** AgentContext.skills: read-only access to a task's pinned skills; grants nothing and executes nothing. */
export class PinnedSkillAccess implements SkillAccess {
  constructor(
    private readonly loader: FileSystemSkillLoader,
    private readonly registry: InMemorySkillRegistry,
    private readonly pins: readonly SkillPin[],
  ) {}

  list(): SkillMetadata[] {
    return this.pins
      .map((p) => this.registry.get(p)?.metadata)
      .filter((m): m is SkillMetadata => m !== undefined);
  }

  async instructions(skillId: string): Promise<string> {
    return this.loader.instructions(this.pin(skillId));
  }

  async resource(skillId: string, relativePath: string): Promise<Uint8Array> {
    return this.loader.resource(this.pin(skillId), relativePath);
  }

  /** Script execution is outside Skill v1. */
  async executeScript(skillId: string, relativePath: string): Promise<never> {
    this.pin(skillId);
    void relativePath;
    throw new AgentropyError(
      'UnsupportedOperation',
      'Skill script execution is not supported in v1',
      { details: { feature: 'skill-scripts' } },
    );
  }

  private pin(skillId: string): SkillPin {
    const p = this.pins.find((x) => x.id === skillId);
    if (!p)
      throw new AgentropyError(
        'CapabilityNotDeclared',
        `Skill ${skillId} is not pinned for this task`,
        { details: { kind: 'skill' } },
      );
    return p;
  }
}
