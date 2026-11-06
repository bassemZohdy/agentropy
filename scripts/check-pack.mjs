#!/usr/bin/env node
// Release packaging check (FEAT-030): packs every library package the way `pnpm publish` would, checks its
// metadata and tarball contents, then installs the tarballs into a fresh consumer project and runs one durable
// task through the installed packages. Publishing itself stays an owner action; this proves the artifacts work.
//
//   node scripts/check-pack.mjs              # after `pnpm build`; the install step needs the npm registry
//   node scripts/check-pack.mjs --no-install # metadata and tarball contents only (offline)
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ALLOWED_LICENSES, sbomFor } from './sbom.mjs';

const root = resolve(import.meta.dirname, '..');
const install = !process.argv.includes('--no-install');
const win = process.platform === 'win32';
const problems = [];
const fail = (m) => problems.push(m);

// Runs in the consumer project against the installed tarballs only.
const SMOKE = `
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentropyError } from '@agentropy/core';
import { createLocalApp, createA2AServer } from '@agentropy/runtime';
import { SqliteStore } from '@agentropy/store-sqlite';
import { PostgresStore } from '@agentropy/store-postgres';
import { ConductorWorkflowEngine } from '@agentropy/workflow-conductor';
import { FakeClock } from '@agentropy/testkit';

for (const x of [AgentropyError, createA2AServer, PostgresStore, ConductorWorkflowEngine, FakeClock])
  if (typeof x !== 'function') throw new Error('missing export');

const pdp = { decide: async (r) => r.principal.tenantId === r.resource.tenantId
  ? { effect: 'allow', policyVersion: 'smoke' } : { effect: 'deny', reason: 'tenant' } };
const store = new SqliteStore({ path: join(mkdtempSync(join(tmpdir(), 'agentropy-smoke-')), 'app.db') });
const app = createLocalApp({ store, pdp });
app.define({
  id: 'echo', version: '1.0.0', displayName: 'echo',
  profile: { id: 'task', version: '1.0.0' },
  implementation: { providerId: 'native-ts', providerVersion: '1.0.0', artifact: { id: 'echo', version: '1.0.0' } },
  inputSchema: true, runtimeRequirements: { guarantees: [] }, policyRef: { id: 'smoke', version: '1.0.0' },
}, { handle: async (inv) => ({ kind: 'completed', output: { echo: inv.input } }) });
const alice = { id: 'alice', type: 'user', tenantId: 't' };
const inst = await app.createInstance({ definition: { id: 'echo', version: '1.0.0' }, ownerId: 'alice', idempotencyKey: 'i' }, alice);
const { taskId } = await app.delegate({ target: { instanceId: inst.id }, input: 'hi', idempotencyKey: 'k', correlationId: 'c' }, alice);
await app.runUntilIdle();
const result = await app.getResult(taskId, alice);
if (JSON.stringify(result) !== '{"echo":"hi"}') throw new Error('unexpected result ' + JSON.stringify(result));
console.log('smoke ok');
`;

function run(cmd, args, cwd) {
  // Windows runs the pnpm/npm .cmd shims through a shell, which takes one quoted command string.
  const shell = win && (cmd === 'pnpm' || cmd === 'npm');
  const quote = (x) => (/[\s"]/.test(x) ? `"${x.replaceAll('"', '\\"')}"` : x);
  const r = shell
    ? spawnSync([cmd, ...args].map(quote).join(' '), {
        cwd,
        encoding: 'utf8',
        shell: true,
      })
    : spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  if (r.status !== 0)
    throw new Error(
      `${cmd} ${args.join(' ')} failed in ${cwd}:\n${r.stdout}\n${r.stderr}`,
    );
  return r.stdout;
}

const libraries = readdirSync(join(root, 'packages')).filter((d) => {
  const j = JSON.parse(
    readFileSync(join(root, 'packages', d, 'package.json'), 'utf8'),
  );
  return d !== 'examples' && j.exports;
});

const work = mkdtempSync(join(tmpdir(), 'agentropy-pack-'));
const tarballs = {};
try {
  for (const dir of libraries) {
    const cwd = join(root, 'packages', dir);
    const j = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
    const at = `packages/${dir}`;
    if (!j.name?.startsWith('@agentropy/'))
      fail(`${at}: name must be in the @agentropy scope`);
    if (!j.description) fail(`${at}: description missing`);
    if (j.license !== 'Apache-2.0')
      fail(`${at}: license must be Apache-2.0 (the repository LICENSE)`);
    if (j.repository?.directory !== at)
      fail(`${at}: repository.directory must be ${at}`);
    if (j.engines?.node !== '>=24') fail(`${at}: engines.node must be >=24`);
    if (j.type !== 'module') fail(`${at}: type must be module`);
    const dot = j.exports?.['.'];
    if (
      dot?.types !== './dist/index.d.ts' ||
      dot?.default !== './dist/index.js'
    )
      fail(`${at}: exports["."] must map types/default to dist/index`);
    for (const f of ['dist', 'LICENSE'])
      if (!j.files?.includes(f)) fail(`${at}: files must include ${f}`);

    const before = new Set(readdirSync(work));
    run('pnpm', ['pack', '--pack-destination', work], cwd);
    const tgz = readdirSync(work).find(
      (f) => !before.has(f) && f.endsWith('.tgz'),
    );
    if (!tgz) {
      fail(`${at}: pnpm pack produced no tarball`);
      continue;
    }
    rmSync(join(cwd, 'LICENSE'), { force: true }); // copied by prepack; the repository keeps one LICENSE
    tarballs[j.name] = join(work, tgz);
    const entries = run('tar', ['-tzf', tgz], work)
      .split(/\r?\n/)
      .filter(Boolean)
      .map((e) => e.replace(/^package\//, ''));
    for (const need of [
      'package.json',
      'LICENSE',
      'dist/index.js',
      'dist/index.d.ts',
    ])
      if (!entries.includes(need)) fail(`${at}: tarball lacks ${need}`);
    for (const e of entries)
      if (
        /(^|\/)(test|src)\//.test(e) ||
        e.endsWith('.tsbuildinfo') ||
        /\.test\.(js|d\.ts)$/.test(e)
      )
        fail(`${at}: tarball must not ship ${e}`);
    // TASK-030.2: the SBOM covers every direct dependency, and every component has a purl and an allowed license.
    const bom = sbomFor(dir);
    const names = new Set(bom.components.map((c) => c.name));
    for (const d of Object.keys(j.dependencies ?? {}))
      if (!names.has(d)) fail(`${at}: SBOM lacks dependency ${d}`);
    for (const c of bom.components) {
      const lic = c.licenses?.[0]?.license?.id;
      if (!c.purl?.startsWith('pkg:npm/'))
        fail(`${at}: SBOM component ${c.name} has no purl`);
      if (!ALLOWED_LICENSES.has(lic))
        fail(
          `${at}: dependency ${c.name}@${c.version} has license ${lic}, not in the allow-list (scripts/sbom.mjs)`,
        );
    }
    const packed = run('tar', ['-xzOf', tgz, 'package/package.json'], work);
    if (packed.includes('workspace:'))
      fail(`${at}: packed package.json still has workspace: ranges`);
  }

  if (install && problems.length === 0) {
    const consumer = join(work, 'consumer');
    const file = (p) => `file:${p.replaceAll('\\', '/')}`;
    const deps = Object.fromEntries(
      Object.entries(tarballs).map(([n, p]) => [n, file(p)]),
    );
    mkdirSync(consumer);
    writeFileSync(
      join(consumer, 'package.json'),
      JSON.stringify(
        {
          name: 'consumer',
          private: true,
          type: 'module',
          dependencies: deps,
          overrides: deps,
        },
        null,
        2,
      ),
    );
    writeFileSync(join(consumer, 'smoke.mjs'), SMOKE);
    run(
      'npm',
      [
        'install',
        '--no-audit',
        '--no-fund',
        '--ignore-scripts',
        '--loglevel=error',
      ],
      consumer,
    );
    const out = run('node', ['smoke.mjs'], consumer).trim();
    if (out !== 'smoke ok') fail(`consumer smoke test printed: ${out}`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (problems.length) {
  console.error(problems.map((p) => `- ${p}`).join('\n'));
  process.exit(1);
}
console.log(
  `Packed ${libraries.length} packages: metadata and contents ok` +
    (install
      ? '; installed tarballs ran a durable task.'
      : ' (install skipped).'),
);
