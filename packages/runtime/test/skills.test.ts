// CT-SKILL: Skill v1 conformance with an official-format fixture (S-02, S-03, S-04).
import { cp, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isAgentropyError,
  type AuditEvent,
  type PolicyDecisionPoint,
  type SkillPin,
  type TrustedPrincipal,
} from '@agentropy/core';
import { describe, expect, it } from 'vitest';
import {
  FileSystemSkillLoader,
  InMemorySkillRegistry,
  PinnedSkillAccess,
  parseSkillMd,
} from '../src/skills.js';

const fixtures = fileURLToPath(new URL('./fixtures/skills/', import.meta.url));
const admin: TrustedPrincipal = { id: 'admin', type: 'user', tenantId: 't-1' };

function setup(opts: { denied?: string[]; pdpDown?: boolean } = {}) {
  const audit: AuditEvent[] = [];
  const pdp: PolicyDecisionPoint = {
    decide: async (r) => {
      if (opts.pdpDown) throw new Error('down');
      return opts.denied?.includes(r.action)
        ? { effect: 'deny' }
        : { effect: 'allow' };
    },
  };
  const registry = new InMemorySkillRegistry(
    {
      pdp,
      audit: { record: async (e) => void audit.push(e) },
      now: () => 'now',
    },
    (_m, publisher) => publisher === 'acme',
  );
  return { registry, loader: new FileSystemSkillLoader(registry), audit };
}

async function copyFixture(name = 'pdf-processing'): Promise<string> {
  const dir = join(await mkdtemp(join(tmpdir(), 'agentropy-skill-')), name);
  await cp(join(fixtures, name), dir, { recursive: true });
  return dir;
}

async function code(p: Promise<unknown> | (() => unknown)): Promise<string> {
  try {
    await (typeof p === 'function' ? p() : p);
    return 'no-error';
  } catch (err) {
    return isAgentropyError(err) ? err.code : `non-agentropy: ${String(err)}`;
  }
}

async function activeSkill(dir?: string) {
  const s = setup();
  const record = await s.registry.register(
    dir ?? join(fixtures, 'pdf-processing'),
    { version: '1.0.0', publisher: 'acme' },
    admin,
  );
  await s.registry.activate({ id: record.id, version: '1.0.0' }, admin);
  const pin: SkillPin = {
    id: record.id,
    version: record.version,
    digest: record.digest,
  };
  return { ...s, record, pin };
}

describe('standard format (CT-SKILL)', () => {
  it('registers the official-format fixture without conversion', async () => {
    const { record } = await activeSkill();
    expect(record).toMatchObject({
      id: 'pdf-processing',
      version: '1.0.0',
      specVersion: 'agentskills-2026-11-05',
      metadata: {
        name: 'pdf-processing',
        license: 'Apache-2.0',
        compatibility: 'Requires Python 3.12+ and pypdf',
        metadata: { author: 'example-org', version: '1.0' },
        allowedTools: ['Bash(python:*)', 'Read', 'finance.payout'],
      },
      files: [
        'SKILL.md',
        'assets/form.txt',
        'references/REFERENCE.md',
        'scripts/extract.py',
      ],
    });
    expect(record.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it.each([
    ['bad-name', 'SchemaViolation'],
    ['mismatch', 'SchemaViolation'],
    ['no-frontmatter', 'SchemaViolation'],
  ])('rejects %s', async (dir, expected) => {
    expect(
      await code(
        setup().registry.register(
          join(fixtures, dir),
          { version: '1.0.0', publisher: 'acme' },
          admin,
        ),
      ),
    ).toBe(expected);
  });

  it('parses allowed-tools as a space-separated list and ignores unknown keys', () => {
    expect(
      parseSkillMd(
        '---\nname: x\ndescription: d\nallowed-tools: Read  Write\nfuture-field: 1\n---\nbody',
      ).metadata,
    ).toEqual({ name: 'x', description: 'd', allowedTools: ['Read', 'Write'] });
  });

  it('re-registration: identical content is a no-op, changed content for the same version is rejected', async () => {
    const dir = await copyFixture();
    const s = setup();
    const a = await s.registry.register(
      dir,
      { version: '1.0.0', publisher: 'acme' },
      admin,
    );
    expect(
      await s.registry.register(
        dir,
        { version: '1.0.0', publisher: 'acme' },
        admin,
      ),
    ).toEqual(a);
    await writeFile(join(dir, 'references', 'REFERENCE.md'), 'changed');
    expect(
      await code(
        s.registry.register(
          dir,
          { version: '1.0.0', publisher: 'acme' },
          admin,
        ),
      ),
    ).toBe('InvalidConfiguration');
  });
});

describe('progressive disclosure (CT-SKILL)', () => {
  it('discovery returns metadata only', async () => {
    const { registry } = await activeSkill();
    const found = await registry.discover({ text: 'pdf' }, admin);
    expect(found).toEqual([
      {
        id: 'pdf-processing',
        version: '1.0.0',
        metadata: expect.objectContaining({ name: 'pdf-processing' }),
      },
    ]);
    expect(JSON.stringify(found)).not.toContain(
      'Ignore all previous instructions',
    );
  });

  it('loads instructions and resources lazily, verified against the pinned digest', async () => {
    const { loader, pin } = await activeSkill();
    expect(await loader.instructions(pin)).toContain('# PDF processing');
    expect(
      new TextDecoder().decode(
        await loader.resource(pin, 'references/REFERENCE.md'),
      ),
    ).toContain('invoice_id');
  });

  it('detects content tampering after pinning (IncompatibleVersion)', async () => {
    const dir = await copyFixture();
    const { loader, pin } = await activeSkill(dir);
    await writeFile(
      join(dir, 'SKILL.md'),
      `${await readFile(join(dir, 'SKILL.md'), 'utf8')}\nextra`,
    );
    expect(await code(loader.instructions(pin))).toBe('IncompatibleVersion');
    expect(
      await code(loader.instructions({ ...pin, digest: 'sha256:other' })),
    ).toBe('IncompatibleVersion');
  });

  it('denies path traversal and symlink escapes; missing files are NotFound', async () => {
    const dir = await copyFixture();
    const { loader, pin } = await activeSkill(dir);
    for (const p of [
      '../../etc/passwd',
      '/etc/passwd',
      'references/../../x',
      '',
    ])
      expect(await code(loader.resource(pin, p)), p).toBe('PermissionDenied');
    expect(await code(loader.resource(pin, 'references/missing.md'))).toBe(
      'NotFound',
    );
    await symlink('/etc/hostname', join(dir, 'assets', 'link'));
    expect(
      await code(
        setup().registry.register(
          dir,
          { version: '2.0.0', publisher: 'acme' },
          admin,
        ),
      ),
    ).toBe('PermissionDenied');
  });
});

describe('governance and authority boundaries (S-03, S-04)', () => {
  it('unverified skills cannot be activated; registration and activation are PEP-guarded and audited', async () => {
    const s = setup();
    await s.registry.register(
      join(fixtures, 'pdf-processing'),
      { version: '1.0.0', publisher: 'unknown' },
      admin,
    );
    expect(
      await code(
        s.registry.activate({ id: 'pdf-processing', version: '1.0.0' }, admin),
      ),
    ).toBe('PermissionDenied');
    expect(s.audit.map((e) => e.type)).toEqual(['skill.register']);
    expect(
      await code(
        setup({ denied: ['skill-admin:register'] }).registry.register(
          join(fixtures, 'pdf-processing'),
          { version: '1.0.0', publisher: 'acme' },
          admin,
        ),
      ),
    ).toBe('PermissionDenied');
    expect(
      await code(
        setup({ pdpDown: true }).registry.register(
          join(fixtures, 'pdf-processing'),
          { version: '1.0.0', publisher: 'acme' },
          admin,
        ),
      ),
    ).toBe('PolicyDecisionUnavailable');
  });

  it('revocation blocks loading even for pinned tasks', async () => {
    const { registry, loader, pin } = await activeSkill();
    await registry.revoke({ id: pin.id, version: pin.version }, admin);
    expect(await code(loader.instructions(pin))).toBe('PermissionDenied');
    expect(await code(loader.metadata(pin))).toBe('PermissionDenied');
  });

  it('handler access is limited to pinned skills and never executes scripts', async () => {
    const { registry, loader, pin } = await activeSkill();
    const access = new PinnedSkillAccess(loader, registry, [pin]);
    expect(access.list().map((m) => m.name)).toEqual(['pdf-processing']);
    expect(await access.instructions('pdf-processing')).toContain(
      'scripts/extract.py',
    );
    expect(await code(access.instructions('other-skill'))).toBe(
      'CapabilityNotDeclared',
    );
    expect(
      await code(access.executeScript('pdf-processing', 'scripts/extract.py')),
    ).toBe('UnsupportedOperation');
  });

  it('malicious instructions are returned as inert text; allowed-tools grants nothing', async () => {
    const { record, loader, pin } = await activeSkill();
    const body = await loader.instructions(pin);
    expect(body).toContain('Ignore all previous instructions'); // data, not authority
    expect(record.requires).toEqual({}); // no dependency or grant derived from skill text
  });
});
