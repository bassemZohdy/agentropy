/** Errors v1 (docs/contracts/errors-v1.md). The catalog is data; tests check it against the contract table. */

export type ErrorCategory =
  | 'validation'
  | 'authorization'
  | 'lifecycle'
  | 'idempotency'
  | 'capability'
  | 'transport'
  | 'limit'
  | 'human-action'
  | 'internal';

export const ERROR_CATALOG = {
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
} as const satisfies Record<
  string,
  { category: ErrorCategory; retryable: boolean }
>;

export type ErrorCode = keyof typeof ERROR_CATALOG;

/** Serialized shape on public boundaries. */
export interface AgentropyErrorShape {
  code: ErrorCode;
  category: ErrorCategory;
  retryable: boolean;
  message: string;
  correlationId?: string;
  details?: Record<string, unknown>;
}

const SECRET_KEY =
  /(secret|token|password|credential|authorization|apikey|api_key|bearer|cookie)/i;

/** Remove secret-looking keys and payload-sized values from details before they leave a trust boundary. */
export function redactDetails(
  details: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!details) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    if (SECRET_KEY.test(key)) continue;
    if (
      value === null ||
      ['string', 'number', 'boolean'].includes(typeof value)
    ) {
      out[key] =
        typeof value === 'string' && value.length > 200
          ? `${value.slice(0, 200)}…`
          : value;
    } else if (
      Array.isArray(value) &&
      value.every((v) => ['string', 'number', 'boolean'].includes(typeof v))
    ) {
      out[key] = value.slice(0, 20);
    }
    // Objects and other values are dropped: they may carry payload data.
  }
  return out;
}

export class AgentropyError extends Error {
  readonly code: ErrorCode;
  readonly category: ErrorCategory;
  readonly retryable: boolean;
  readonly correlationId?: string;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    options: {
      details?: Record<string, unknown>;
      correlationId?: string;
      cause?: unknown;
    } = {},
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = 'AgentropyError';
    this.code = code;
    this.category = ERROR_CATALOG[code].category;
    this.retryable = ERROR_CATALOG[code].retryable;
    this.correlationId = options.correlationId;
    this.details = options.details;
  }

  /** Public serialization: redacted details, no stack, no cause. */
  toJSON(): AgentropyErrorShape {
    const shape: AgentropyErrorShape = {
      code: this.code,
      category: this.category,
      retryable: this.retryable,
      message: this.message,
    };
    if (this.correlationId) shape.correlationId = this.correlationId;
    const details = redactDetails(this.details);
    if (details && Object.keys(details).length) shape.details = details;
    return shape;
  }
}

export function isAgentropyError(
  value: unknown,
  code?: ErrorCode,
): value is AgentropyError {
  return (
    value instanceof AgentropyError &&
    (code === undefined || value.code === code)
  );
}

export function isErrorCode(value: string): value is ErrorCode {
  return Object.prototype.hasOwnProperty.call(ERROR_CATALOG, value);
}

/** Maps any thrown value to an AgentropyError; unknown errors become Internal without leaking their message. */
export function toAgentropyError(
  value: unknown,
  correlationId?: string,
): AgentropyError {
  if (value instanceof AgentropyError) return value;
  return new AgentropyError('Internal', 'Internal error', {
    correlationId,
    cause: value,
  });
}
