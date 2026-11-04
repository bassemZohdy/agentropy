#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const files = execFileSync('git', ['ls-files', '--', '*.md'], { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean);
const missing = [];
for (const file of files) {
  const content = readFileSync(file, 'utf8');
  let fenced = false;
  for (const [i, line] of content.split('\n').entries()) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const re = /!?(?:\[[^\]]*\])\((<[^>]+>|[^\s)]+)(?:\s+["'][^"']*["'])?\)/g;
    for (const match of line.matchAll(re)) {
      let target = match[1].replace(/^<|>$/g, '');
      if (/^(?:https?:|mailto:|tel:|data:|#|\/\/)/i.test(target)) continue;
      target = target.split('#')[0].split('?')[0];
      if (!target) continue;
      try {
        target = decodeURIComponent(target);
      } catch {
        missing.push(`${file}:${i + 1}: malformed encoded link ${target}`);
        continue;
      }
      const candidate = resolve(dirname(file), target);
      if (!existsSync(candidate)) {
        missing.push(`${file}:${i + 1}: ${target}`);
      } else if (!statSync(candidate).isFile() && !statSync(candidate).isDirectory()) {
        missing.push(`${file}:${i + 1}: invalid target ${target}`);
      }
    }
  }
}
if (missing.length) {
  console.error(`Broken local Markdown links (${missing.length}):\n${missing.join('\n')}`);
  process.exitCode = 1;
} else {
  console.log(`Checked ${files.length} Markdown files: local link targets exist.`);
}
