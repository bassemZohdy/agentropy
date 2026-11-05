// AC-04 (table part): every listed edge is legal and every unlisted edge fails InvalidState.
// The state-leakage half of AC-04 (unauthorized caller gets NotFound) is exercised by the TaskService suite.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isAgentropyError } from '../src/errors.js';
import {
  EXECUTION_MACHINE,
  HUMAN_ACTION_MACHINE,
  INSTANCE_MACHINE,
  TASK_MACHINE,
  assertTransition,
  isTerminal,
  type StateMachine,
} from '../src/lifecycle.js';

const doc = readFileSync(
  new URL('../../../docs/runtime-contract.md', import.meta.url),
  'utf8',
);

/** Parse "| T9 | `created`, `assigned`, `waiting` | `failed` |" rows into "id:from>to" keys. */
function documentedEdges(prefix: RegExp): Set<string> {
  const keys = new Set<string>();
  for (const m of doc.matchAll(
    /^\| (\w+) \| (—|[`a-z, ]+) \| `([a-z]+)` \|/gm,
  )) {
    if (!prefix.test(m[1]!)) continue;
    const froms =
      m[2] === '—'
        ? ['∅']
        : [...m[2]!.matchAll(/`([a-z]+)`/g)].map((f) => f[1]!);
    for (const f of froms) keys.add(`${m[1]}:${f}>${m[3]}`);
  }
  return keys;
}

const implementedEdges = <S extends string>(m: StateMachine<S>) =>
  new Set(m.transitions.map((t) => `${t.id}:${t.from ?? '∅'}>${t.to}`));

function everyPair<S extends string>(
  machine: StateMachine<S>,
): [S | null, S][] {
  const pairs: [S | null, S][] = [];
  for (const from of [null, ...machine.states])
    for (const to of machine.states) pairs.push([from, to]);
  return pairs;
}

describe.each([
  TASK_MACHINE,
  EXECUTION_MACHINE,
  INSTANCE_MACHINE,
  HUMAN_ACTION_MACHINE,
] as StateMachine<string>[])('$name transition table (AC-04)', (machine) => {
  it('accepts every listed edge', () => {
    for (const t of machine.transitions)
      expect(assertTransition(machine, t.from, t.to).to).toBe(t.to);
  });

  it('rejects every unlisted edge with InvalidState (generated)', () => {
    const listed = new Set(machine.transitions.map((t) => `${t.from}>${t.to}`));
    let rejected = 0;
    for (const [from, to] of everyPair(machine)) {
      if (listed.has(`${from}>${to}`)) continue;
      try {
        assertTransition(machine, from, to);
        expect.fail(`${machine.name} ${from} → ${to} should be illegal`);
      } catch (err) {
        expect(isAgentropyError(err, 'InvalidState')).toBe(true);
        rejected++;
      }
    }
    expect(rejected).toBeGreaterThan(0);
  });

  it('has no edge leaving a terminal state', () => {
    for (const t of machine.transitions)
      if (t.from) expect(isTerminal(machine, t.from), `${t.id}`).toBe(false);
  });
});

describe('tables match the authoritative runtime contract', () => {
  it('task edges T1…T11 equal the documented table', () => {
    expect(implementedEdges(TASK_MACHINE)).toEqual(documentedEdges(/^T\d+$/));
  });

  it('execution edges E1…E8 equal the documented table', () => {
    expect(implementedEdges(EXECUTION_MACHINE)).toEqual(
      documentedEdges(/^E\d+b?$/),
    );
  });

  it('rejects an edge ID that does not match the requested edge', () => {
    expect(() =>
      assertTransition(TASK_MACHINE, 'running', 'assigned', 'T5'),
    ).toThrowError(/Illegal task transition/);
    expect(assertTransition(TASK_MACHINE, 'running', 'assigned', 'T6').id).toBe(
      'T6',
    );
  });
});
