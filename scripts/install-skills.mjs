#!/usr/bin/env node
// Copies the Agent Skills in plugins/agentropy/skills/ into the folder a harness scans for skills (TASK-039).
//   node scripts/install-skills.mjs <target-dir> [--force] [--only name[,name]]
// Each skill is a self-contained folder with a SKILL.md, so any harness that implements the Agent Skills format can
// read it. An existing folder is left alone unless --force is given.
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'plugins',
  'agentropy',
  'skills',
);
const args = process.argv.slice(2);
const force = args.includes('--force');
const onlyAt = args.indexOf('--only');
const only =
  onlyAt >= 0
    ? new Set((args[onlyAt + 1] ?? '').split(',').filter(Boolean))
    : undefined;
const target = args.find(
  (a, i) => !a.startsWith('--') && args[i - 1] !== '--only',
);

if (!target) {
  console.error(
    'usage: node scripts/install-skills.mjs <target-dir> [--force] [--only name[,name]]',
  );
  process.exit(2);
}

const available = readdirSync(source).filter((n) =>
  statSync(join(source, n)).isDirectory(),
);
const unknown = [...(only ?? [])].filter((n) => !available.includes(n));
if (unknown.length) {
  console.error(
    `unknown skill(s): ${unknown.join(', ')}; available: ${available.join(', ')}`,
  );
  process.exit(2);
}

const dest = resolve(target);
mkdirSync(dest, { recursive: true });
let installed = 0;
for (const name of available) {
  if (only && !only.has(name)) continue;
  const to = join(dest, name);
  if (existsSync(to)) {
    if (!force) {
      console.log(`skip ${name}: ${to} exists (use --force to replace it)`);
      continue;
    }
    rmSync(to, { recursive: true, force: true });
  }
  cpSync(join(source, name), to, { recursive: true });
  console.log(`installed ${name} -> ${to}`);
  installed++;
}
console.log(`${installed} skill(s) installed into ${dest}`);
