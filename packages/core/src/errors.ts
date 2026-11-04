/** Public error catalog (v1). Defined in docs/contracts/errors-v1.md. */
export const ERROR_DEFINITIONS = {
  SchemaViolation: { category: 'validation', retryable: false },
  InvalidConfiguration: { category: 'validation', retryable: false },
  NotFound: { category: 'validation', retryable: false },
  Unauthenticated: { category: 'authorization', retryable: false },
  PermissionDenied: { category: 'authorization', retryable: false },
  TenantMismatch: { category: 'authorization', retryable: false },
  AuthorityExpired: { category: 'authorization', retryable: false },
  PolicyDecisionUnavailable: { category: 'authorization', retryable: false },
  InvalidState: { category: 'lifecycle', retryable: false },
  StaleRevision: { category: 'lifecycle', retryable: true },
  NotReady: { category: 'lifecycle', retryable: true },
  TaskFailed: { category: 'lifecycle', retryable: false },
  TaskCancelled: { category: 'lifecycle', retryable: false },
  InstanceUnavailable: { category: 'lifecycle', retryable: true },
  IncompatibleVersion: { category: 'lifecycle', retryable: false },
  IdempotencyConflict: { category: 'idempotency', retryable: false },
  CapabilityNotDeclared: { category: 'capability', retryable: false },
  CapabilityUnavailable: { category: 'capability', retryable: false },
  UnsupportedOperation: { category: 'capability', retryable: false },
  GuaranteeUnavailable: { category: 'capability', retryable: false },
  ProviderUnavailable: { category: 'transport', retryable: true },
  Timeout: { category: 'transport', retryable: true },
  UnknownAcceptance: { category: 'transport', retryable: true },
  NoCompatibleRoute: { category: 'transport', retryable: false },
  RemoteUnavailable: { category: 'transport', retryable: true },
  QuotaExceeded: { category: 'limit', retryable: true },
  BudgetExceeded: { category: 'limit', retryable: false },
  DelegationDepthExceeded: { category: 'limit', retryable: false },
  FanOutExceeded: { category: 'limit', retryable: false },
  ActionExpired: { category: 'human-action', retryable: false },
  ActionRevoked: { category: 'human-action', retryable: false },
  ActionConflict: { category: 'human-action', retryable: false },
  NotAssignee: { category: 'human-action', retryable: false },
  Internal: { category: 'internal', retryable: false },
  AuditCommitUnavailable: { category: 'internal', retryable: false },
} as const;

export type ErrorCode = keyof typeof ERROR_DEFINITIONS;
export type ErrorCategory = (typeof ERROR_DEFINITIONS)[ErrorCode]['category'];

export interface AgentropyErrorValue {
  code: ErrorCode;
  category: ErrorCategory;
  retryable: boolean;
  message: string;
  correlationId?: string;
  details?: Record<string, unknown>;
}

/** Never include untrusted input or provider errors in a public error message. */
export function agentropyError(
  code: ErrorCode,
  message: string,
  options: { correlationId?: string; details?: Record<string, unknown> } = {},
): AgentropyErrorValue {
  const metadata = ERROR_DEFINITIONS[code];
  const result: AgentropyErrorValue = {
    code,
    category: metadata.category,
    retryable: metadata.retryable,
    message,
  };
  if (options.correlationId !== undefined) {
    result.correlationId = options.correlationId;
  }
  if (options.details !== undefined) {
    result.details = options.details;
  }
  return result;
}

export function isAgentropyErrorValue(
  value: unknown,
): value is AgentropyErrorValue {
  if (typeof value !== 'object' || value === null) return false;
  if (Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.code !== 'string') return false;
  if (!Object.prototype.hasOwnProperty.call(ERROR_DEFINITIONS, record.code)) {
    return false;
  }
  const metadata = ERROR_DEFINITIONS[record.code as ErrorCode];
  if (record.category !== metadata.category) return false;
  if (record.retryable !== metadata.retryable) return false;
  if (typeof record.message !== 'string') return false;
  if (record.correlationId !== undefined) {
    if (typeof record.correlationId !== 'string') return false;
  }
  if (record.details !== undefined) {
    if (record.details === null || typeof record.details !== 'object') {
      return false;
    }
    if (Array.isArray(record.details)) return false;
  }
  return true;
}
