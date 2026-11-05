/** Minimal 5-field cron (minute hour day-of-month month day-of-week), UTC only, for schedule wake-ups. */
import { AgentropyError } from './errors.js';

const RANGES: [number, number][] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 6],
];

function parseField(field: string, [min, max]: [number, number]): Set<number> {
  const out = new Set<number>();
  for (const part of field.split(',')) {
    const [range, stepText] = part.split('/');
    const step = stepText === undefined ? 1 : Number(stepText);
    const [lo, rawHi] =
      range === '*'
        ? [min, max]
        : (range!.split('-').map(Number) as [number, number?]);
    const hi = rawHi ?? (stepText === undefined ? lo : max);
    if (
      ![lo, hi, step].every(Number.isInteger) ||
      lo < min ||
      hi! > max ||
      lo > hi! ||
      step < 1
    ) {
      throw new AgentropyError(
        'SchemaViolation',
        `Invalid cron field "${field}"`,
        { details: { reason: 'cron' } },
      );
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

/** Next occurrence strictly after `afterIso`. Only the UTC timezone is supported in v1. */
export function nextOccurrence(
  cron: string,
  timezone: string,
  afterIso: string,
): string {
  if (timezone !== 'UTC')
    throw new AgentropyError(
      'UnsupportedOperation',
      'Only UTC schedules are supported in v1',
      { details: { feature: 'timezone' } },
    );
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5)
    throw new AgentropyError('SchemaViolation', 'Cron needs 5 fields', {
      details: { reason: 'cron' },
    });
  const [mi, ho, dom, mo, dow] = fields.map((f, i) =>
    parseField(f, RANGES[i]!),
  );
  const t = new Date(afterIso);
  t.setUTCSeconds(0, 0);
  t.setUTCMinutes(t.getUTCMinutes() + 1);
  for (let i = 0; i < 366 * 24 * 60; i++) {
    if (
      mo!.has(t.getUTCMonth() + 1) &&
      dom!.has(t.getUTCDate()) &&
      dow!.has(t.getUTCDay()) &&
      ho!.has(t.getUTCHours()) &&
      mi!.has(t.getUTCMinutes())
    ) {
      return t.toISOString();
    }
    t.setUTCMinutes(t.getUTCMinutes() + 1);
  }
  throw new AgentropyError(
    'SchemaViolation',
    'Cron has no occurrence within a year',
    { details: { reason: 'cron' } },
  );
}
