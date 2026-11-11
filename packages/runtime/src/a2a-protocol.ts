/**
 * A2A protocol 1.0 shapes shared by the server and the client (TASK-031 split of `a2a.ts`): message, part and task
 * types, state and error-code mappings, and part encoding.
 */
import { AgentropyError, type TaskSnapshot } from '@agentropy/core';

export const A2A_PROTOCOL_VERSION = '1.0';

export type A2ATaskState =
  | 'TASK_STATE_SUBMITTED'
  | 'TASK_STATE_WORKING'
  | 'TASK_STATE_INPUT_REQUIRED'
  | 'TASK_STATE_AUTH_REQUIRED'
  | 'TASK_STATE_COMPLETED'
  | 'TASK_STATE_FAILED'
  | 'TASK_STATE_CANCELED'
  | 'TASK_STATE_REJECTED';

/** A2A 1.0 `Part`: exactly one of `text`, `raw` (base64 bytes), `url` or `data`. */
export interface A2APart {
  text?: string;
  raw?: string;
  url?: string;
  data?: unknown;
  mediaType?: string;
  filename?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Input handed to an agent for a message that is not a single text or data part (FEAT-034.4). File content is
 * passed as given (base64 or a URL); the runtime never fetches a URL, and agents treat all of it as data.
 */
export type A2AInputPart =
  | { kind: 'text'; text: string; mediaType?: string }
  | {
      kind: 'file';
      raw?: string;
      url?: string;
      filename?: string;
      mediaType?: string;
    }
  | { kind: 'data'; data: unknown; mediaType?: string };

/** Parts accepted in one message. */
export const MAX_PARTS = 16;

export interface A2AMessage {
  role: 'ROLE_USER' | 'ROLE_AGENT';
  messageId: string;
  contextId?: string;
  taskId?: string;
  parts: A2APart[];
  metadata?: Record<string, unknown>;
}

export interface A2ATask {
  id: string;
  contextId?: string;
  status: {
    state: A2ATaskState;
    timestamp: string;
    /** Why a task ended badly: the runtime's outcome message of a failed or cancelled task (TASK-035.3). */
    message?: A2AMessage;
  };
  artifacts?: { artifactId: string; parts: A2APart[] }[];
  /** The caller's messages for this task, newest last (FEAT-044.2; only when the endpoint keeps history). */
  history?: A2AMessage[];
  metadata?: Record<string, unknown>;
}

export const TO_A2A: Record<TaskSnapshot['status'], A2ATaskState> = {
  created: 'TASK_STATE_SUBMITTED',
  assigned: 'TASK_STATE_SUBMITTED',
  running: 'TASK_STATE_WORKING',
  waiting: 'TASK_STATE_WORKING',
  completed: 'TASK_STATE_COMPLETED',
  failed: 'TASK_STATE_FAILED',
  cancelled: 'TASK_STATE_CANCELED',
};

export const FROM_A2A: Record<A2ATaskState, TaskSnapshot['status']> = {
  TASK_STATE_SUBMITTED: 'created',
  TASK_STATE_WORKING: 'running',
  TASK_STATE_INPUT_REQUIRED: 'waiting',
  TASK_STATE_AUTH_REQUIRED: 'waiting',
  TASK_STATE_COMPLETED: 'completed',
  TASK_STATE_FAILED: 'failed',
  TASK_STATE_CANCELED: 'cancelled',
  TASK_STATE_REJECTED: 'failed',
};

export const TERMINAL_A2A = new Set<A2ATaskState>([
  'TASK_STATE_COMPLETED',
  'TASK_STATE_FAILED',
  'TASK_STATE_CANCELED',
  'TASK_STATE_REJECTED',
]);

/** A2A JSON-RPC error codes (spec section 9) and the Errors v1 codes they correspond to. */
export const A2A_ERRORS: Record<number, string> = {
  [-32001]: 'NotFound', // TaskNotFoundError
  [-32002]: 'InvalidState', // TaskNotCancelableError
  [-32003]: 'UnsupportedOperation', // PushNotificationNotSupportedError
  [-32004]: 'UnsupportedOperation', // UnsupportedOperationError
  [-32005]: 'SchemaViolation', // ContentTypeNotSupportedError
  [-32009]: 'IncompatibleVersion', // VersionNotSupportedError
  [-32600]: 'SchemaViolation',
  [-32601]: 'UnsupportedOperation',
  [-32602]: 'SchemaViolation',
};

export function toA2ACode(code: string): number {
  switch (code) {
    case 'NotFound':
    case 'TenantMismatch':
      return -32001;
    case 'InvalidState':
      return -32002;
    case 'UnsupportedOperation':
      return -32004;
    case 'IncompatibleVersion':
      return -32009;
    case 'SchemaViolation':
      return -32602;
    default:
      return -32603;
  }
}

export const encodeInput = (input: unknown): A2APart[] =>
  typeof input === 'string'
    ? [{ text: input }]
    : [{ text: JSON.stringify(input ?? null), mediaType: 'application/json' }];

const BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function invalidPart(message: string): AgentropyError {
  return new AgentropyError('SchemaViolation', message, {
    details: { reason: 'parts' },
  });
}

/** Validates one part and returns its input form. */
export function inputPart(p: A2APart): A2AInputPart {
  if (typeof p !== 'object' || p === null) throw invalidPart('Invalid part');
  const present = (['text', 'raw', 'url', 'data'] as const).filter(
    (k) => p[k] !== undefined,
  );
  if (present.length !== 1)
    throw invalidPart('A part has exactly one of text, raw, url or data');
  for (const f of ['mediaType', 'filename'] as const)
    if (p[f] !== undefined && typeof p[f] !== 'string')
      throw invalidPart(`Invalid ${f}`);
  const meta = {
    ...(p.mediaType ? { mediaType: p.mediaType } : {}),
  };
  switch (present[0]) {
    case 'text':
      if (typeof p.text !== 'string') throw invalidPart('Invalid text part');
      return { kind: 'text', text: p.text, ...meta };
    case 'data':
      return { kind: 'data', data: p.data, ...meta };
    case 'raw':
      if (typeof p.raw !== 'string' || !BASE64.test(p.raw))
        throw invalidPart('raw must be base64');
      return {
        kind: 'file',
        raw: p.raw,
        ...(p.filename ? { filename: p.filename } : {}),
        ...meta,
      };
    default: {
      let u: URL;
      try {
        u = new URL(String(p.url));
      } catch {
        throw invalidPart('Invalid file url');
      }
      if (u.protocol !== 'https:' && u.protocol !== 'http:')
        throw invalidPart('File url must be http or https');
      return {
        kind: 'file',
        url: u.href,
        ...(p.filename ? { filename: p.filename } : {}),
        ...meta,
      };
    }
  }
}

/**
 * Message parts as agent input: one text part is its text (JSON when `application/json`), one data part is its
 * value; anything else (several parts, file parts) is `{ parts: A2AInputPart[] }`.
 */
export function decodeParts(parts: A2APart[] | undefined): unknown {
  if (!Array.isArray(parts) || parts.length === 0)
    throw invalidPart('A message needs at least one part');
  if (parts.length > MAX_PARTS)
    throw invalidPart(`At most ${MAX_PARTS} parts are accepted`);
  const decoded = parts.map(inputPart);
  if (decoded.length !== 1 || decoded[0]!.kind === 'file')
    return { parts: decoded };
  if (decoded[0]!.kind === 'data') return decoded[0]!.data;
  const [p] = parts;
  if (p!.mediaType === 'application/json') {
    try {
      return JSON.parse(p!.text!);
    } catch {
      throw new AgentropyError('SchemaViolation', 'Invalid JSON part');
    }
  }
  if (p!.mediaType !== undefined && p!.mediaType !== 'text/plain')
    throw new AgentropyError('SchemaViolation', 'Unsupported content type', {
      details: { reason: 'contentType', a2a: -32005 },
    });
  return p!.text;
}
