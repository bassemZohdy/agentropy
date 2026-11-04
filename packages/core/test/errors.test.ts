import { describe, expect, it } from 'vitest';
import {
  ERROR_DEFINITIONS,
  agentropyError,
  isAgentropyErrorValue,
} from '../src/errors.js';

describe('Error Contract v1', () => {
  it('registers stable codes and metadata', () => {
    expect(Object.keys(ERROR_DEFINITIONS)).toHaveLength(35);
    expect(ERROR_DEFINITIONS.PolicyDecisionUnavailable).toEqual({
      category: 'authorization',
      retryable: false,
    });
    expect(ERROR_DEFINITIONS.AuditCommitUnavailable).toEqual({
      category: 'internal',
      retryable: false,
    });
    expect(ERROR_DEFINITIONS.UnknownAcceptance.retryable).toBe(true);
  });

  it('constructs typed error values with safe optional fields', () => {
    expect(agentropyError('InvalidState', 'Cannot transition')).toEqual({
      code: 'InvalidState',
      category: 'lifecycle',
      retryable: false,
      message: 'Cannot transition',
    });
    const stale = agentropyError('StaleRevision', 'Read current state', {
      correlationId: 'request-1',
    });
    expect(isAgentropyErrorValue(stale)).toBe(true);
  });

  it('rejects spoofed code, category, retryability and details', () => {
    const denied = agentropyError('PermissionDenied', 'Denied');
    expect(isAgentropyErrorValue({ ...denied, code: 'Unknown' })).toBe(false);
    expect(isAgentropyErrorValue({ ...denied, retryable: true })).toBe(false);
    expect(isAgentropyErrorValue({ ...denied, category: 'transport' })).toBe(
      false,
    );
    expect(isAgentropyErrorValue({ ...denied, details: [] })).toBe(false);
  });
});
