#!/usr/bin/env node
// One-time npm bootstrap for the first release (TASK-043.3, docs/release.md "Owner setup runbook").
//
// npm only offers a trusted publisher in the settings of a package that already exists, so the release workflow
// cannot make the first publish of a package. The owner runs this once, logged in to npm, to create each library
// package with a contentless placeholder version, published under the dist-tag `bootstrap` and deprecated at once.
// After that the owner adds the trusted publishers and the tag v0.1.0 publishes the real packages from CI.
//
//   node scripts/npm-bootstrap.mjs            # prints what it would publish (dry run, the default)
//   node scripts/npm-bootstrap.mjs --publish  # publishes and deprecates the placeholders (needs `npm login`)
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const PACKAGES = [
  'core',
  'runtime',
  'store-sqlite',
  'store-postgres',
  'workflow-conductor',
  'testkit',
];
const VERSION = '0.0.0-bootstrap.0';
const TAG = 'bootstrap';
const MESSAGE =
  'Placeholder that reserves the package name; install @agentropy/* at version 0.1.0 or later.';

const root = resolve(import.meta.dirname, '..');
const publish = process.argv.includes('--publish');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const run = (args, cwd) => {
  const r = spawnSync(npm, args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (r.status !== 0) {
    console.error(
      `npm ${args.join(' ')} failed (exit ${r.status ?? r.signal})`,
    );
    process.exit(1);
  }
};

if (publish) {
  const who = spawnSync(npm, ['whoami'], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  if (who.status !== 0) {
    console.error('Not logged in to npm: run `npm login` first.');
    process.exit(1);
  }
  console.log(`Publishing as ${who.stdout.trim()}`);
}

for (const dir of PACKAGES) {
  const real = JSON.parse(
    readFileSync(join(root, 'packages', dir, 'package.json'), 'utf8'),
  );
  const name = real.name;
  const existing = spawnSync(npm, ['view', name, 'versions', '--json'], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  if (existing.status === 0) {
    // A rerun after a failed deprecate: deprecate the placeholder again (harmless if it already is).
    const versions = [JSON.parse(existing.stdout || '[]')].flat();
    if (publish && versions.includes(VERSION)) {
      run(['deprecate', `${name}@${VERSION}`, MESSAGE], root);
      console.log(`${name}: already on npm, placeholder deprecated`);
    } else {
      console.log(`${name}: already on npm, skipped`);
    }
    continue;
  }
  const manifest = {
    name,
    version: VERSION,
    description: MESSAGE,
    license: real.license,
    repository: real.repository,
    homepage: real.homepage,
    files: ['README.md'],
  };
  if (!publish) {
    console.log(
      `${name}: would publish ${VERSION} under dist-tag ${TAG}, then deprecate it`,
    );
    continue;
  }
  const tmp = mkdtempSync(join(tmpdir(), 'agentropy-bootstrap-'));
  try {
    writeFileSync(
      join(tmp, 'package.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    writeFileSync(join(tmp, 'README.md'), `# ${name}\n\n${MESSAGE}\n`);
    run(['publish', '--access', 'public', '--tag', TAG], tmp);
    run(['deprecate', `${name}@${VERSION}`, MESSAGE], tmp);
    console.log(`${name}: published ${VERSION} and deprecated it`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (!publish)
  console.log('\nDry run. Run with --publish to publish the placeholders.');
