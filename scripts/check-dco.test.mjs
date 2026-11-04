import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { test } from 'node:test';

const validator = resolve('scripts/check-dco.mjs');

function command(cwd, executable, args) {
  const result = spawnSync(executable, args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test('DCO validator accepts signed commits and rejects unsigned commits', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentropy-dco-'));
  try {
    command(dir, 'git', ['init', '-q']);
    command(dir, 'git', ['config', 'user.name', 'DCO Test']);
    command(dir, 'git', ['config', 'user.email', 'dco@example.test']);
    writeFileSync(join(dir, 'fixture.txt'), 'initial\n');
    command(dir, 'git', ['add', 'fixture.txt']);
    command(dir, 'git', ['commit', '-qm', 'initial']);
    const base = command(dir, 'git', ['rev-parse', 'HEAD']);

    writeFileSync(join(dir, 'fixture.txt'), 'signed\n');
    command(dir, 'git', ['add', 'fixture.txt']);
    command(dir, 'git', ['commit', '-qsm', 'signed change']);
    const signed = command(dir, 'git', ['rev-parse', 'HEAD']);
    let result = spawnSync(process.execPath, [validator, base, signed], {
      cwd: dir,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);

    writeFileSync(join(dir, 'fixture.txt'), 'unsigned\n');
    command(dir, 'git', ['add', 'fixture.txt']);
    command(dir, 'git', ['commit', '-qm', 'unsigned change']);
    const unsigned = command(dir, 'git', ['rev-parse', 'HEAD']);
    result = spawnSync(process.execPath, [validator, signed, unsigned], {
      cwd: dir,
      encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Missing DCO Signed-off-by/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
