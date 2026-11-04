#!/usr/bin/env node
// Validate commit sign-offs on a PR; never treat the sign-off as authentication.
import { execFileSync } from 'node:child_process';

const [base, head] = process.argv.slice(2);
if (!/^[a-f0-9]{40}$/.test(base ?? '') || !/^[a-f0-9]{40}$/.test(head ?? '')) {
  console.error('Usage: node scripts/check-dco.mjs <base-sha> <head-sha>');
  process.exit(2);
}

const commits = execFileSync('git', ['rev-list', '--no-merges', `${base}..${head}`], {
  encoding: 'utf8',
})
  .trim()
  .split('\n')
  .filter(Boolean);

const signOff = /^Signed-off-by:\s+.+\s+<[^<>\s@]+@[^<>\s@]+>\s*$/im;
let failures = 0;
for (const commit of commits) {
  const message = execFileSync('git', ['show', '--no-patch', '--format=%B', commit], {
    encoding: 'utf8',
  });
  if (!signOff.test(message)) {
    console.error(`Missing DCO Signed-off-by in ${commit}`);
    failures++;
  }
}
if (failures) {
  console.error(`${failures} commit(s) without DCO sign-off. Amend with git commit -s.`);
  process.exit(1);
}
console.log(`DCO check passed for ${commits.length} non-merge commit(s).`);
