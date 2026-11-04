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
  return {
    code,
    category: metadata.category,
    retryable: metadata.retryable,
    message,
    ...(options.correlationId === undefined ? {} : { correlationId: options.correlationId }),
    ...(options.details === undefined ? {} : { details: options.details }),
  };
}

export function isAgentropyErrorValue(value: unknown): value is AgentropyErrorValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.code !== 'string' || !Object.prototype.hasOwnProperty.call(ERROR_DEFINITIONS, record.code)) return false;
  const metadata = ERROR_DEFINITIONS[record.code as ErrorCode];
  return record.category === metadata.category && record.retryable === metadata.retryable &&
    typeof record.message === 'string' &&
    (record.correlationId === undefined || typeof record.correlationId === 'string') &&
    (record.details === undefined || (typeof record.details === 'object' && record.details !== null && !Array.isArray(record.details)));
}
