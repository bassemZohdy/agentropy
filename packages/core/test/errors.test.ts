import { describe, expect, it } from 'vitest';
import { ERROR_DEFINITIONS, agentropyError, isAgentropyErrorValue } from '../src/errors.js';

describe('Error Contract v1', () => {
  it('registers all error codes with stable category and retryability', () => {
    expect(Object.keys(ERROR_DEFINITIONS)).toHaveLength(35);
    expect(ERROR_DEFINITIONS.PolicyDecisionUnavailable).toEqual({ category: 'authorization', retryable: false });
    expect(ERROR_DEFINITIONS.AuditCommitUnavailable).toEqual({ category: 'internal', retryable: false });
    expect(ERROR_DEFINITIONS.UnknownAcceptance.retryable).toBe(true);
  });

  it('constructs typed error values with safe optional fields', () => {
    expect(agentropyError('InvalidState', 'Cannot transition')).toEqual({
      code: 'InvalidState', category: 'lifecycle', retryable: false, message: 'Cannot transition',
    });
    expect(isAgentropyErrorValue(agentropyError('StaleRevision', 'Read current state', { correlationId: 'request-1' }))).toBe(true);
  });

  it('rejects spoofed code, category, retryability and invalid details', () => {
    expect(isAgentropyErrorValue({ code: 'Unknown', category: 'internal', retryable: false, message: 'x' })).toBe(false);
    expect(isAgentropyErrorValue({ ...agentropyError('PermissionDenied', 'Denied'), retryable: true })).toBe(false);
    expect(isAgentropyErrorValue({ ...agentropyError('PermissionDenied', 'Denied'), category: 'transport' })).toBe(false);
    expect(isAgentropyErrorValue({ ...agentropyError('PermissionDenied', 'Denied'), details: [] })).toBe(false);
  });
});
