// CT-ERRORS: Errors v1 catalog completeness and redaction.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  AgentropyError,
  ERROR_CATALOG,
  isAgentropyError,
  isErrorCode,
  toAgentropyError,
} from '../src/errors.js';

const doc = readFileSync(
  new URL('../../../docs/contracts/errors-v1.md', import.meta.url),
  'utf8',
);
const catalogSection = doc.split('## Catalog')[1]!.split('\n## ')[0]!;
const rows = [
  ...catalogSection.matchAll(
    /^\| (`[A-Za-z]+`(?: \/ `[A-Za-z]+`)*) \| ([a-z-]+) \| (yes|no)\*? \|/gm,
  ),
].flatMap((m) =>
  [...m[1]!.matchAll(/`([A-Za-z]+)`/g)].map((c) => ({
    code: c[1]!,
    category: m[2]!,
    retryable: m[3] === 'yes',
  })),
);

describe('Errors v1 catalog (CT-ERRORS)', () => {
  it('parses the contract table', () => {
    expect(rows.length).toBeGreaterThanOrEqual(35);
  });

  it('implements every documented code with the documented category and retryability', () => {
    for (const row of rows) {
      expect(isErrorCode(row.code), row.code).toBe(true);
      const entry = ERROR_CATALOG[row.code as keyof typeof ERROR_CATALOG];
      expect(entry.category, row.code).toBe(row.category);
      expect(entry.retryable, row.code).toBe(row.retryable);
    }
  });

  it('defines no undocumented codes', () => {
    const documented = new Set(rows.map((r) => r.code));
    expect(
      Object.keys(ERROR_CATALOG).filter((c) => !documented.has(c)),
    ).toEqual([]);
  });

  it('never makes PermissionDenied or the ADR-0025 codes retryable', () => {
    expect(new AgentropyError('PermissionDenied', 'no').retryable).toBe(false);
    expect(
      new AgentropyError('PolicyDecisionUnavailable', 'pdp').retryable,
    ).toBe(false);
    expect(
      new AgentropyError('AuditCommitUnavailable', 'audit').retryable,
    ).toBe(false);
  });
});

describe('AgentropyError serialization', () => {
  it('redacts secret-looking keys and drops object payloads', () => {
    const err = new AgentropyError('SchemaViolation', 'bad input', {
      correlationId: 'c-1',
      details: {
        reason: 'missingStepKey',
        accessToken: 'abc',
        apiKey: 'k',
        payload: { card: '4111' },
        path: ['a', 'b'],
      },
    });
    const json = err.toJSON();
    expect(json).toEqual({
      code: 'SchemaViolation',
      category: 'validation',
      retryable: false,
      message: 'bad input',
      correlationId: 'c-1',
      details: { reason: 'missingStepKey', path: ['a', 'b'] },
    });
    expect(JSON.stringify(json)).not.toContain('abc');
    expect(JSON.stringify(json)).not.toContain('4111');
  });

  it('maps unknown thrown values to Internal without leaking their message', () => {
    const mapped = toAgentropyError(new Error('db password=hunter2'), 'c-2');
    expect(isAgentropyError(mapped, 'Internal')).toBe(true);
    expect(JSON.stringify(mapped.toJSON())).not.toContain('hunter2');
    const original = new AgentropyError('NotFound', 'x');
    expect(toAgentropyError(original)).toBe(original);
  });
});
