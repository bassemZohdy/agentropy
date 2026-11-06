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

export interface A2APart {
  text?: string;
  mediaType?: string;
}

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
  status: { state: A2ATaskState; timestamp: string };
  artifacts?: { artifactId: string; parts: A2APart[] }[];
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

export function decodeParts(parts: A2APart[] | undefined): unknown {
  if (
    !Array.isArray(parts) ||
    parts.length !== 1 ||
    typeof parts[0]?.text !== 'string'
  )
    throw new AgentropyError(
      'SchemaViolation',
      'Exactly one text part is supported',
      { details: { reason: 'parts' } },
    );
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
