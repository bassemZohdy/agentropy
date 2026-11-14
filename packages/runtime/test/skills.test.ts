// CT-SKILL: Skill v1 conformance with an official-format fixture (S-02, S-03, S-04).
import { cp, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isAgentropyError,
  type AuditEvent,
  BUILTIN_PROFILES,
  type PolicyDecisionPoint,
  type SkillPin,
  type TrustedPrincipal,
} from '@agentropy/core';
import { FakePolicy } from '@agentropy/testkit';
import { describe, expect, it } from 'vitest';
import { createLocalApp } from '../src/app.js';
import { sqliteTempStore } from './harness.js';
import {
  FileSystemSkillLoader,
  InMemorySkillRegistry,
  PinnedSkillAccess,
  parseSkillMd,
} from '../src/skills.js';

const fixtures = fileURLToPath(new URL('./fixtures/skills/', import.meta.url));

/** Windows without Developer Mode refuses symlinks (EPERM); CI must always be able to create them. */
async function symlinksAllowed(): Promise<boolean> {
  const dir = await mkdtemp(join(tmpdir(), 'agentropy-symlink-probe-'));
  try {
    await symlink(join(dir, 'missing'), join(dir, 'link'));
    return true;
  } catch (err) {
    if (process.env['CI']) throw err;
    return false;
  }
}
const canSymlink = await symlinksAllowed();
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

  it('denies path traversal; missing files are NotFound', async () => {
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
  });

  it.skipIf(!canSymlink)('denies symlink escapes', async () => {
    const dir = await copyFixture();
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

describe('skills in createLocalApp (FEAT-041.1)', () => {
  it('accepts a definition that selects a skill, pins it, and gives the handler read access', async () => {
    const { registry, loader, record } = await activeSkill();
    const app = createLocalApp({
      store: sqliteTempStore(),
      pdp: new FakePolicy(),
      profiles: BUILTIN_PROFILES,
      skills: { registry, loader },
    });
    app.define(
      {
        id: 'reader',
        version: '1.0.0',
        displayName: 'reader',
        profile: { id: 'task', version: '1.0.0' },
        implementation: {
          providerId: 'native-ts',
          providerVersion: '1.0.0',
          artifact: { id: 'reader', version: '1.0.0' },
        },
        inputSchema: true,
        runtimeRequirements: { guarantees: [] },
        policyRef: { id: 'default', version: '1.0.0' },
        skills: [{ id: record.id, versionRange: '^1.0.0' }],
      },
      {
        handle: async (_inv, ctx) => ({
          kind: 'completed',
          output: {
            names: ctx.skills.list().map((m) => m.name),
            instructions: (await ctx.skills.instructions(record.id)).length > 0,
          },
        }),
      },
    );
    const inst = await app.createInstance(
      {
        definition: { id: 'reader', version: '1.0.0' },
        ownerId: admin.id,
        idempotencyKey: 'i',
      },
      admin,
    );
    const { taskId } = await app.delegate(
      {
        target: { instanceId: inst.id },
        input: {},
        idempotencyKey: 'k',
        correlationId: 'c',
      },
      admin,
    );
    await app.runUntilIdle();
    expect(await app.getResult(taskId, admin)).toEqual({
      names: ['pdf-processing'],
      instructions: true,
    });
  });

  it('without a skill registry a definition that selects a skill is refused at acceptance', async () => {
    const app = createLocalApp({
      store: sqliteTempStore(),
      pdp: new FakePolicy(),
      profiles: BUILTIN_PROFILES,
    });
    app.define(
      {
        id: 'reader',
        version: '1.0.0',
        displayName: 'reader',
        profile: { id: 'task', version: '1.0.0' },
        implementation: {
          providerId: 'native-ts',
          providerVersion: '1.0.0',
          artifact: { id: 'reader', version: '1.0.0' },
        },
        inputSchema: true,
        runtimeRequirements: { guarantees: [] },
        policyRef: { id: 'default', version: '1.0.0' },
        skills: [{ id: 'pdf-processing', versionRange: '^1.0.0' }],
      },
      { handle: async () => ({ kind: 'completed', output: null }) },
    );
    const inst = await app.createInstance(
      {
        definition: { id: 'reader', version: '1.0.0' },
        ownerId: admin.id,
        idempotencyKey: 'i',
      },
      admin,
    );
    expect(
      await code(
        app.delegate(
          {
            target: { instanceId: inst.id },
            input: {},
            idempotencyKey: 'k',
            correlationId: 'c',
          },
          admin,
        ),
      ),
    ).toBe('CapabilityUnavailable');
  });
});

describe('skill registration bounds (FEAT-041.3)', () => {
  it('refuses a skill folder with more than 500 files', async () => {
    const dir = await copyFixture();
    await Promise.all(
      Array.from({ length: 500 }, (_, i) =>
        writeFile(join(dir, 'assets', `f${i}.txt`), 'x'),
      ),
    );
    const s = setup();
    expect(
      await code(
        s.registry.register(
          dir,
          { version: '1.0.0', publisher: 'acme' },
          admin,
        ),
      ),
    ).toBe('SchemaViolation');
  });
});

describe('skill status lives in the store (FEAT-074)', () => {
  /** One process: its own registry over the shared store. */
  const process_ = (store: ReturnType<typeof sqliteTempStore>) => {
    const pdp: PolicyDecisionPoint = {
      decide: async () => ({ effect: 'allow' }),
    };
    const registry = new InMemorySkillRegistry(
      { pdp, audit: { record: async () => undefined }, now: () => 'now' },
      (_m, publisher) => publisher === 'acme',
      { store },
    );
    return {
      registry,
      loader: new FileSystemSkillLoader(registry),
      register: () =>
        registry.register(
          join(fixtures, 'pdf-processing'),
          { version: '1.0.0', publisher: 'acme' },
          admin,
        ),
    };
  };

  it('FEAT-074: a skill revoked through one app is refused by a second app on the same store, also after both restart', async () => {
    const store = sqliteTempStore();
    const a = process_(store);
    const b = process_(store);
    const rec = await a.register();
    const ref = { id: rec.id, version: '1.0.0' };
    await a.registry.activate(ref, admin);
    expect((await b.register()).status).toBe('active');
    const pin: SkillPin = { ...ref, digest: rec.digest };
    expect((await b.loader.metadata(pin)).name).toBeDefined();
    await a.registry.revoke(ref, admin);
    expect(await code(b.loader.metadata(pin))).toBe('PermissionDenied');
    expect(await b.registry.discover({}, admin)).toEqual([]);

    const a2 = process_(store);
    expect((await a2.register()).status).toBe('revoked');
    expect(await code(a2.registry.activate(ref, admin))).toBe('InvalidState');
    expect(await code(a2.loader.metadata(pin))).toBe('PermissionDenied');
    // A second revoke says so, from any worker.
    expect(await code(b.registry.revoke(ref, admin))).toBe('InvalidState');
  });

  it('FEAT-074: an unverified skill is not made active by a stored row', async () => {
    const store = sqliteTempStore();
    const bad = new InMemorySkillRegistry(
      {
        pdp: { decide: async () => ({ effect: 'allow' }) },
        audit: { record: async () => undefined },
        now: () => 'now',
      },
      () => false,
      { store },
    );
    const rec = await bad.register(
      join(fixtures, 'pdf-processing'),
      { version: '1.0.0', publisher: 'someone' },
      admin,
    );
    expect(
      await code(bad.activate({ id: rec.id, version: '1.0.0' }, admin)),
    ).toBe('PermissionDenied');
    await store.transaction((tx) =>
      tx.insert('lifecycle', `skill:${rec.id}@1.0.0`, {
        kind: 'skill',
        id: rec.id,
        version: '1.0.0',
        status: 'active',
        digest: rec.digest,
      }),
    );
    expect(
      (await bad.refreshed({ id: rec.id, version: '1.0.0' }))?.status,
    ).toBe('registered');
  });
});
