#!/usr/bin/env node
// Readiness and traceability check (TASK-010). Read-only; exits non-zero on any violation.
//  1. Every M1 acceptance check (AC-xx from docs/poc-scope.md + mandatory SEC IDs) is in the acceptance matrix.
//  2. Every matrix root exists in TODO.md or CHANGELOG.md; once drained to CHANGELOG.md its test file
//     must exist and name the criterion ID verbatim.
//  3. The legacy-ID crosswalk maps every archived legacy ID exactly once, preserves status, and points
//     to an existing root (or `archive` for completed items).
//  4. Every contract's title revision equals the highest revision in its revision-history table.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const read = (p) => readFileSync(p, 'utf8');
const errors = [];
const fail = (msg) => errors.push(msg);

const MANDATORY_SEC = ['SEC-01', 'SEC-02', 'SEC-03', 'SEC-04', 'SEC-07']; // docs/plans/M1-SECURITY-ACCEPTANCE-DECISION.md

const todo = read('TODO.md');
const changelog = read('CHANGELOG.md');
const idIn = (text, id) => text.includes(`**${id}**`) || new RegExp(`Includes:[^\\n]*\\b${id.replace('.', '\\.')}\\b`).test(text);
const rootExists = (id) => idIn(todo, id) || idIn(changelog, id);
const drained = (id) => idIn(changelog, id);

// 1 + 2: acceptance matrix
const matrix = JSON.parse(read('docs/plans/acceptance-matrix.json')).criteria;
const byId = new Map(matrix.map((c) => [c.id, c]));
if (byId.size !== matrix.length) fail('acceptance-matrix.json: duplicate criterion IDs');
const acIds = [...read('docs/poc-scope.md').matchAll(/^\| (AC-\d{2}) \|/gm)].map((m) => m[1]);
if (acIds.length !== 20) fail(`poc-scope.md: expected 20 AC rows, found ${acIds.length}`);
for (const id of [...acIds, ...MANDATORY_SEC]) {
  if (!byId.has(id)) fail(`acceptance matrix is missing ${id}`);
}
let verified = 0;
for (const c of matrix) {
  if (!rootExists(c.root)) fail(`${c.id}: root ${c.root} not found in TODO.md or CHANGELOG.md`);
  if (!/^packages\/[a-z-]+\/test\/[\w.-]+\.test\.ts$/.test(c.test)) fail(`${c.id}: test path ${c.test} is outside packages/*/test`);
  if (drained(c.root)) {
    if (!existsSync(c.test)) fail(`${c.id}: ${c.root} is drained but ${c.test} does not exist`);
    else if (!read(c.test).includes(c.id)) fail(`${c.id}: ${c.test} does not reference ${c.id}`);
    else verified++;
  }
}

// 3: legacy crosswalk
const archive = read('docs/plans/archive/TODO-legacy-2026-11-05.md');
const legacy = new Map(
  [...archive.matchAll(/^- \[([ x])\] ([A-Z][A-Z0-9]*-\d+) /gm)].map((m) => [m[2], m[1] === 'x' ? 'complete' : 'open']),
);
const crosswalk = read('docs/plans/TODO-ID-CROSSWALK.md');
const section = crosswalk.split('## Migration destinations (2026-11-05)')[1] ?? '';
if (!section) fail('TODO-ID-CROSSWALK.md: missing "Migration destinations (2026-11-05)" section');
const seen = new Map();
for (const m of section.matchAll(/^\| `([A-Z][A-Z0-9]*-\d+)` \| (complete|open) \| ([A-Za-z0-9-]+) \|$/gm)) {
  const [, id, status, dest] = m;
  if (seen.has(id)) fail(`crosswalk: ${id} mapped more than once`);
  seen.set(id, { status, dest });
}
for (const [id, status] of legacy) {
  const row = seen.get(id);
  if (!row) {
    fail(`crosswalk: legacy ${id} has no destination`);
    continue;
  }
  if (row.status !== status) fail(`crosswalk: ${id} status changed (${status} → ${row.status})`);
  if (status === 'complete' && row.dest !== 'archive') fail(`crosswalk: completed ${id} must map to archive`);
  if (status === 'open' && row.dest === 'archive') fail(`crosswalk: open ${id} cannot be archived as complete`);
  if (row.dest !== 'archive' && !rootExists(row.dest)) fail(`crosswalk: ${id} → ${row.dest} not found in TODO.md or CHANGELOG.md`);
}
for (const id of seen.keys()) if (!legacy.has(id)) fail(`crosswalk: ${id} is not a legacy ID`);
if (legacy.size === 0) fail('archive: no legacy IDs parsed');

// 3b: design follow-up resolution ledger (TASK-026.1)
{
  const doc = read('docs/plans/DESIGN-FOLLOWUPS.md');
  const [items, ledger = ''] = doc.split('## Resolution ledger');
  const itemIds = [...items.matchAll(/^\| `([A-Z]-\d+)` \| /gm)].map((m) => m[1]);
  const rows = new Map();
  for (const m of ledger.matchAll(/^\| `([A-Z]-\d+)` \| (closed|partial|open|deferred) \| ([^|]+) \| ([^|]+) \|$/gm)) {
    if (rows.has(m[1])) fail(`follow-ups: ${m[1]} appears twice in the resolution ledger`);
    rows.set(m[1], { status: m[2], evidence: m[3].trim(), owner: m[4].trim() });
  }
  if (!ledger) fail('DESIGN-FOLLOWUPS.md: missing "Resolution ledger" section');
  for (const id of itemIds) {
    const r = rows.get(id);
    if (!r) { fail(`follow-ups: ${id} has no resolution row`); continue; }
    if ((r.status === 'closed' || r.status === 'partial') && !existsSync(r.evidence))
      fail(`follow-ups: ${id} is ${r.status} but evidence ${r.evidence} does not exist`);
    if (r.status === 'closed' && r.owner !== '—') fail(`follow-ups: closed ${id} must not name a remaining owner`);
    if (r.status !== 'closed') {
      const owner = r.owner.split('.')[0];
      if (r.owner !== 'Deferred' && !rootExists(owner) && !rootExists(r.owner))
        fail(`follow-ups: ${id} names owner ${r.owner}, which is not in TODO.md or CHANGELOG.md`);
    }
  }
  for (const id of rows.keys()) if (!itemIds.includes(id)) fail(`follow-ups: ledger row ${id} is not a follow-up item`);
  if (itemIds.length === 0) fail('DESIGN-FOLLOWUPS.md: no follow-up items parsed');
}

// 3c: threat model evidence (FEAT-027.7)
{
  const tm = read('docs/security/threat-model.md');
  const rows = [...tm.matchAll(/^\| (TM-\d+) \|[^\n]*\| ([^|\n]+) \|$/gm)];
  if (rows.length === 0) fail('threat-model.md: no TM rows parsed');
  for (const [, id, evidence] of rows) {
    const path = /`([^`]+)`/.exec(evidence)?.[1];
    if (path) {
      if (!existsSync(path)) fail(`threat-model: ${id} evidence ${path} does not exist`);
    } else {
      const owner = /planned \(([A-Z]+-\d+(?:\.\d+)?)\)/.exec(evidence)?.[1];
      if (!owner) fail(`threat-model: ${id} needs a test path or "planned (ROOT)"`);
      else if (!rootExists(owner.split('.')[0]) && !rootExists(owner))
        fail(`threat-model: ${id} names unknown owner ${owner}`);
    }
  }
}

// 4: contract revision headers
for (const file of readdirSync('docs/contracts')) {
  const text = read(join('docs/contracts', file));
  const title = text.match(/^# .*revision (\d+)/m);
  const revs = [...text.matchAll(/^\| (\d+) \| \d{4}-\d{2}-\d{2} \|/gm)].map((m) => Number(m[1]));
  if (!title) fail(`docs/contracts/${file}: title does not state "revision N"`);
  else if (revs.length && Number(title[1]) !== Math.max(...revs))
    fail(`docs/contracts/${file}: title revision ${title[1]} but history max is ${Math.max(...revs)}`);
}

if (errors.length) {
  console.error(`Readiness check failed (${errors.length}):\n- ${errors.join('\n- ')}`);
  process.exitCode = 1;
} else {
  console.log(
    `Readiness check passed: ${matrix.length} criteria (${verified} verified by drained roots), ${legacy.size} legacy IDs mapped, contract revisions consistent.`,
  );
}
