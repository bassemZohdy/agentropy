// Cron wake-ups (core/src/cron.ts): five-field UTC cron, strictly-after semantics, and the rejections the scheduler
// relies on (FEAT-018, TASK-037.1).
import { describe, expect, it } from 'vitest';
import { isAgentropyError } from '../src/errors.js';
import { nextOccurrence } from '../src/cron.js';

const next = (cron: string, after: string) =>
  nextOccurrence(cron, 'UTC', after);
const rejects = (fn: () => unknown, code: string) => {
  try {
    fn();
  } catch (err) {
    expect(isAgentropyError(err, code as never)).toBe(true);
    return;
  }
  throw new Error('expected an error');
};

describe('nextOccurrence', () => {
  it('finds the next minute strictly after the given instant', () => {
    expect(next('* * * * *', '2026-11-06T10:15:00.000Z')).toBe(
      '2026-11-06T10:16:00.000Z',
    );
    expect(next('30 10 * * *', '2026-11-06T10:15:42.000Z')).toBe(
      '2026-11-06T10:30:00.000Z',
    );
    // At the exact time it is the next day: "after" is strict.
    expect(next('30 10 * * *', '2026-11-06T10:30:00.000Z')).toBe(
      '2026-11-07T10:30:00.000Z',
    );
  });

  it('supports lists, ranges and steps', () => {
    expect(next('0,15,45 * * * *', '2026-11-06T10:20:00.000Z')).toBe(
      '2026-11-06T10:45:00.000Z',
    );
    expect(next('0 9-17 * * *', '2026-11-06T18:00:00.000Z')).toBe(
      '2026-11-07T09:00:00.000Z',
    );
    expect(next('*/20 * * * *', '2026-11-06T10:01:00.000Z')).toBe(
      '2026-11-06T10:20:00.000Z',
    );
    expect(next('10-30/10 * * * *', '2026-11-06T10:11:00.000Z')).toBe(
      '2026-11-06T10:20:00.000Z',
    );
    expect(next('5/20 * * * *', '2026-11-06T10:06:00.000Z')).toBe(
      '2026-11-06T10:25:00.000Z',
    );
  });

  it('handles month, day-of-week and year boundaries', () => {
    // 2026-11-06 is a Friday; day-of-week 1 is Monday.
    expect(next('0 8 * * 1', '2026-11-06T10:00:00.000Z')).toBe(
      '2026-11-09T08:00:00.000Z',
    );
    expect(next('0 0 1 1 *', '2026-11-06T10:00:00.000Z')).toBe(
      '2027-01-01T00:00:00.000Z',
    );
    expect(next('0 0 29 2 *', '2027-11-06T10:00:00.000Z')).toBe(
      '2028-02-29T00:00:00.000Z',
    );
  });

  it('requires both day fields to match when both are restricted (AND, unlike Vixie cron)', () => {
    // The 13th that is a Friday: 2026-11-13 is a Friday.
    expect(next('0 0 13 * 5', '2026-11-06T10:00:00.000Z')).toBe(
      '2026-11-13T00:00:00.000Z',
    );
  });

  it('rejects bad input with typed errors', () => {
    rejects(
      () => next('* * * *', '2026-11-06T10:00:00.000Z'),
      'SchemaViolation',
    );
    rejects(
      () => next('60 * * * *', '2026-11-06T10:00:00.000Z'),
      'SchemaViolation',
    );
    rejects(
      () => next('* 24 * * *', '2026-11-06T10:00:00.000Z'),
      'SchemaViolation',
    );
    rejects(
      () => next('* * 0 * *', '2026-11-06T10:00:00.000Z'),
      'SchemaViolation',
    );
    rejects(
      () => next('* * * 13 *', '2026-11-06T10:00:00.000Z'),
      'SchemaViolation',
    );
    rejects(
      () => next('* * * * 7', '2026-11-06T10:00:00.000Z'),
      'SchemaViolation',
    );
    rejects(
      () => next('20-10 * * * *', '2026-11-06T10:00:00.000Z'),
      'SchemaViolation',
    );
    rejects(
      () => next('*/0 * * * *', '2026-11-06T10:00:00.000Z'),
      'SchemaViolation',
    );
    rejects(
      () => next('x * * * *', '2026-11-06T10:00:00.000Z'),
      'SchemaViolation',
    );
    rejects(
      () =>
        nextOccurrence(
          '* * * * *',
          'Europe/Berlin',
          '2026-11-06T10:00:00.000Z',
        ),
      'UnsupportedOperation',
    );
  });

  it('gives up on a schedule that does not occur within a year', () => {
    // The next leap day is more than 366 days away from this instant.
    rejects(
      () => next('0 0 29 2 *', '2026-11-06T10:00:00.000Z'),
      'SchemaViolation',
    );
    rejects(
      () => next('0 0 30 2 *', '2026-11-06T10:00:00.000Z'),
      'SchemaViolation',
    );
  });
});
