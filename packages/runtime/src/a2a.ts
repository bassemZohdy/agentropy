/**
 * A2A provider (C-03, FEAT-027.8): JSON-RPC binding of the A2A protocol, pinned to protocol version 1.0
 * (a2a-protocol.org specification 1.0.0; the normative field list is the spec's `a2a.proto`).
 *
 * - Outbound: `A2ACommunicationProvider` implements the Communication SPI for targets with an `endpoint`. It sends
 *   `SendMessage`, `GetTask` and `CancelTask` with the `A2A-Version` header and a credential resolved per call for
 *   this runtime's own service identity. Local grants never cross the boundary; the caller's identity is not
 *   forwarded as authority (threat model TM-27/TM-28). The remote task stays authoritative; local state is a
 *   normalized projection.
 * - Inbound: `createA2AServer` maps the same methods onto a `DirectTarget` (e.g. `localAppTarget(app, …)`), with the
 *   principal produced by the transport's authentication. It reuses the AgentService PEPs.
 *
 * Not implemented in v1: streaming (`SendStreamingMessage`, `SubscribeToTask`; `subscribe` polls `GetTask`), push
 * notifications, `ListTasks`, continuing a task with a follow-up message (`message.taskId`), and file parts.
 * Agentropy-to-Agentropy envelopes (`send`) travel as a `SendMessage` whose `metadata["agentropy/envelope"]`
 * carries the AgentMessage; that key is an Agentropy extension, ignored by other peers.
 */
import {
  AgentropyError,
  isAgentropyError,
  isErrorCode,
  toAgentropyError,
  validateAgentMessage,
  type AgentEvent,
  type AgentMessage,
  type AgentRef,
  type AgentCommunicationProvider,
  type CallContext,
  type CommunicationFeatures,
  type CommunicationOperation,
  type CredentialProvider,
  type DelegationRequest,
  type MessageReceipt,
  type RemoteTaskRef,
  type RemoteTaskState,
  type RouteBinding,
  type TaskSnapshot,
  type TrustedPrincipal,
} from '@agentropy/core';
import type { LocalApp } from './app.js';
import type { DirectTarget } from './communication.js';

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

const TO_A2A: Record<TaskSnapshot['status'], A2ATaskState> = {
  created: 'TASK_STATE_SUBMITTED',
  assigned: 'TASK_STATE_SUBMITTED',
  running: 'TASK_STATE_WORKING',
  waiting: 'TASK_STATE_WORKING',
  completed: 'TASK_STATE_COMPLETED',
  failed: 'TASK_STATE_FAILED',
  cancelled: 'TASK_STATE_CANCELED',
};

const FROM_A2A: Record<A2ATaskState, TaskSnapshot['status']> = {
  TASK_STATE_SUBMITTED: 'created',
  TASK_STATE_WORKING: 'running',
  TASK_STATE_INPUT_REQUIRED: 'waiting',
  TASK_STATE_AUTH_REQUIRED: 'waiting',
  TASK_STATE_COMPLETED: 'completed',
  TASK_STATE_FAILED: 'failed',
  TASK_STATE_CANCELED: 'cancelled',
  TASK_STATE_REJECTED: 'failed',
};

const TERMINAL_A2A = new Set<A2ATaskState>([
  'TASK_STATE_COMPLETED',
  'TASK_STATE_FAILED',
  'TASK_STATE_CANCELED',
  'TASK_STATE_REJECTED',
]);

/** A2A JSON-RPC error codes (spec section 9) and the Errors v1 codes they correspond to. */
const A2A_ERRORS: Record<number, string> = {
  [-32001]: 'NotFound', // TaskNotFoundError
  [-32002]: 'InvalidState', // TaskNotCancelableError
  [-32004]: 'UnsupportedOperation', // UnsupportedOperationError
  [-32005]: 'SchemaViolation', // ContentTypeNotSupportedError
  [-32009]: 'IncompatibleVersion', // VersionNotSupportedError
  [-32600]: 'SchemaViolation',
  [-32601]: 'UnsupportedOperation',
  [-32602]: 'SchemaViolation',
};

function toA2ACode(code: string): number {
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

const encodeInput = (input: unknown): A2APart[] =>
  typeof input === 'string'
    ? [{ text: input }]
    : [{ text: JSON.stringify(input ?? null), mediaType: 'application/json' }];

function decodeParts(parts: A2APart[] | undefined): unknown {
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

// ---------------------------------------------------------------------------------------------------------------
// Inbound

export interface A2AServerOptions {
  /** The local agent instance this endpoint exposes (passed to the target as `target.instanceId`). */
  instanceId?: string;
  now?: () => string;
}

export interface A2AHttpResponse {
  status: number;
  body: {
    jsonrpc: '2.0';
    id: unknown;
    result?: unknown;
    error?: { code: number; message: string; data?: unknown };
  };
}

export interface A2AServer {
  handle(
    request: unknown,
    principal: TrustedPrincipal | undefined,
    headers?: { 'a2a-version'?: string },
  ): Promise<A2AHttpResponse>;
}

export function createA2AServer(
  target: DirectTarget,
  o: A2AServerOptions = {},
): A2AServer {
  const now = o.now ?? (() => new Date().toISOString());
  const task = (
    s: TaskSnapshot & { output?: unknown },
    contextId?: string,
  ): A2ATask => ({
    id: s.taskId,
    ...(contextId ? { contextId } : {}),
    status: { state: TO_A2A[s.status], timestamp: now() },
    ...(s.status === 'completed' && s.output !== undefined
      ? {
          artifacts: [
            { artifactId: `${s.taskId}:output`, parts: encodeInput(s.output) },
          ],
        }
      : {}),
  });
  return {
    async handle(raw, principal, headers = {}) {
      const req = raw as {
        jsonrpc?: string;
        id?: unknown;
        method?: string;
        params?: Record<string, unknown>;
      };
      const id = req?.id ?? null;
      const fail = (
        status: number,
        code: number,
        err: AgentropyError,
      ): A2AHttpResponse => ({
        status,
        body: {
          jsonrpc: '2.0',
          id,
          error: { code, message: err.message, data: err.toJSON() },
        },
      });
      try {
        if (!principal?.id || !principal.tenantId)
          return fail(
            401,
            -32600,
            new AgentropyError('Unauthenticated', 'Authentication required'),
          );
        const version = headers['a2a-version'];
        if (version !== undefined && version !== A2A_PROTOCOL_VERSION)
          return fail(
            200,
            -32009,
            new AgentropyError(
              'IncompatibleVersion',
              `A2A version ${version} is not supported`,
              {
                details: { supported: A2A_PROTOCOL_VERSION },
              },
            ),
          );
        if (req?.jsonrpc !== '2.0' || typeof req.method !== 'string')
          return fail(
            200,
            -32600,
            new AgentropyError('SchemaViolation', 'Invalid JSON-RPC request'),
          );
        const p = req.params ?? {};
        switch (req.method) {
          case 'SendMessage': {
            const m = p['message'] as A2AMessage | undefined;
            if (!m?.messageId || m.role !== 'ROLE_USER')
              throw new AgentropyError(
                'SchemaViolation',
                'message with messageId and ROLE_USER required',
              );
            if (m.taskId)
              throw new AgentropyError(
                'UnsupportedOperation',
                'Continuing an existing task is not supported',
              );
            const envelope = m.metadata?.['agentropy/envelope'];
            if (envelope !== undefined) {
              // Agentropy envelope: identity always comes from the transport principal.
              const msg = validateAgentMessage(envelope);
              const { accepted } = await target.receive(
                {
                  ...msg,
                  tenantId: principal.tenantId,
                  actor: {
                    principalId: principal.id,
                    principalType: principal.type,
                  },
                },
                principal,
              );
              return {
                status: 200,
                body: {
                  jsonrpc: '2.0',
                  id,
                  result: {
                    message: {
                      role: 'ROLE_AGENT',
                      messageId: `${m.messageId}:ack`,
                      parts: [
                        {
                          text: JSON.stringify({ accepted }),
                          mediaType: 'application/json',
                        },
                      ],
                    },
                  },
                },
              };
            }
            const input = decodeParts(m.parts);
            const { taskId } = await target.delegate(
              {
                target: o.instanceId ? { instanceId: o.instanceId } : {},
                input,
                idempotencyKey: m.messageId,
                correlationId: m.contextId ?? m.messageId,
              },
              principal,
            );
            const snap = await target.getTask(taskId, principal);
            return {
              status: 200,
              body: {
                jsonrpc: '2.0',
                id,
                result: { task: task(snap, m.contextId) },
              },
            };
          }
          case 'GetTask': {
            if (typeof p['id'] !== 'string')
              throw new AgentropyError('SchemaViolation', 'id required');
            const snap = await target.getTask(p['id'], principal);
            return {
              status: 200,
              body: { jsonrpc: '2.0', id, result: task(snap) },
            };
          }
          case 'CancelTask': {
            if (typeof p['id'] !== 'string')
              throw new AgentropyError('SchemaViolation', 'id required');
            const snap = await target.cancel(p['id'], principal);
            return {
              status: 200,
              body: { jsonrpc: '2.0', id, result: task(snap) },
            };
          }
          default:
            return fail(
              200,
              -32601,
              new AgentropyError(
                'UnsupportedOperation',
                `Method ${req.method} not supported`,
              ),
            );
        }
      } catch (err) {
        const e = toAgentropyError(err);
        const a2a =
          (e.details?.['a2a'] as number | undefined) ?? toA2ACode(e.code);
        return fail(200, a2a, e);
      }
    },
  };
}

/** Exposes one instance of a LocalApp as an A2A target (inbound), reusing every AgentService check. */
export function localAppTarget(app: LocalApp): DirectTarget {
  return {
    delegate: (request, caller) => app.delegate(request, caller),
    getTask: async (taskId, caller) => {
      const s = await app.getTask(taskId, caller);
      if (s.status !== 'completed') return s;
      return {
        ...s,
        output: await app.getResult(taskId, caller),
      } as TaskSnapshot;
    },
    cancel: (taskId, caller) => app.cancel(taskId, caller),
    subscribe: (taskId, caller) => {
      const stream = app.subscribe(taskId, caller);
      return (async function* () {
        for await (const e of stream)
          yield {
            eventId: `${taskId}:${e.revision}:${e.sequence}`,
            taskId,
            type: e.type,
            revision: e.revision,
            payload: { status: e.status },
          } satisfies AgentEvent;
      })();
    },
    receive: async () => ({ accepted: false }),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Outbound

type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<{ status: number; json(): Promise<unknown> }>;

export interface A2AProviderOptions {
  fetch?: FetchLike;
  /** Credential for this runtime's identity at the peer (resolved per call, sent as a Bearer token). */
  credentialRef?: string;
  credentials?: CredentialProvider;
  now?: () => string;
  /** `subscribe` polls GetTask (no streaming in v1). */
  pollMs?: number;
  /** Polls after the first snapshot before `subscribe` ends without a terminal state (default unlimited). */
  maxPolls?: number;
}

export class A2ACommunicationProvider implements AgentCommunicationProvider {
  readonly id = 'a2a';
  readonly features: CommunicationFeatures = {
    operations: ['delegate', 'send', 'getTask', 'cancel', 'subscribe'],
    streaming: false,
    pushNotifications: false,
    durability: 'provider-dependent',
    protocol: 'a2a',
    protocolVersion: A2A_PROTOCOL_VERSION,
  };
  private seq = 0;

  constructor(private readonly o: A2AProviderOptions = {}) {}

  supports(target: AgentRef, operation: CommunicationOperation): boolean {
    return !!target.endpoint && this.features.operations.includes(operation);
  }

  private async call<T>(
    endpoint: string,
    method: string,
    params: unknown,
    ctx: CallContext,
  ): Promise<T> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'a2a-version': A2A_PROTOCOL_VERSION,
    };
    if (this.o.credentialRef) {
      if (!this.o.credentials)
        throw new AgentropyError(
          'InvalidConfiguration',
          'credentialRef needs a CredentialProvider',
        );
      const cred = (await this.o.credentials.resolve(this.o.credentialRef, {
        tenantId: ctx.caller.tenantId,
        principal: ctx.caller,
        purpose: 'a2a',
      })) as { token?: string };
      if (!cred?.token)
        throw new AgentropyError(
          'AuthorityExpired',
          'A2A credential unavailable',
          {
            details: { kind: 'credential', status: 'expired' },
          },
        );
      headers.authorization = `Bearer ${cred.token}`;
    }
    let res: { status: number; json(): Promise<unknown> };
    try {
      res = await (this.o.fetch ?? ((u, i) => fetch(u, i)))(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: `rpc-${++this.seq}`,
          method,
          params,
        }),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
    } catch (err) {
      if (isAgentropyError(err)) throw err;
      throw new AgentropyError('RemoteUnavailable', 'A2A peer unreachable', {
        details: { protocol: 'a2a' },
      });
    }
    if (res.status === 401 || res.status === 403)
      throw new AgentropyError(
        'AuthorityExpired',
        'A2A peer rejected our credential',
        {
          details: { kind: 'credential', status: 'expired' },
        },
      );
    if (res.status >= 500)
      throw new AgentropyError('RemoteUnavailable', 'A2A peer error', {
        details: { status: res.status },
      });
    const body = (await res.json()) as {
      result?: T;
      error?: {
        code?: number;
        data?: { code?: string; details?: Record<string, unknown> };
      };
    };
    if (body.error) {
      // Prefer an Agentropy peer's typed code; otherwise map the A2A code. Remote messages are not trusted text.
      const fromPeer = body.error.data?.code;
      const code =
        fromPeer && isErrorCode(fromPeer)
          ? fromPeer
          : (A2A_ERRORS[body.error.code ?? 0] ?? 'RemoteUnavailable');
      throw new AgentropyError(
        code as never,
        `A2A peer error ${body.error.code ?? ''}`.trim(),
        {
          details: { protocol: 'a2a', a2aCode: body.error.code ?? null },
        },
      );
    }
    return body.result as T;
  }

  private now(): string {
    return this.o.now?.() ?? new Date().toISOString();
  }

  private state(t: A2ATask): RemoteTaskState {
    return {
      remoteState: t.status.state,
      normalized: FROM_A2A[t.status.state] ?? 'unknown',
      observedAt: this.now(),
    };
  }

  async delegate<I>(
    route: RouteBinding,
    request: DelegationRequest<I>,
    ctx: CallContext,
  ): Promise<RemoteTaskRef> {
    const endpoint = route.target.endpoint!;
    const result = await this.call<{ task?: A2ATask }>(
      endpoint,
      'SendMessage',
      {
        message: {
          role: 'ROLE_USER',
          messageId: request.idempotencyKey,
          contextId: request.correlationId,
          parts: encodeInput(request.input),
        } satisfies A2AMessage,
        configuration: { returnImmediately: true },
      },
      ctx,
    );
    if (!result?.task?.id)
      throw new AgentropyError(
        'RemoteUnavailable',
        'A2A peer did not return a task',
      );
    // Remote task mapping: the local projection is keyed by protocol + remote ID; the remote stays authoritative.
    return {
      localTaskId: `a2a:${result.task.id}`,
      route,
      remoteTaskId: result.task.id,
    };
  }

  async send(
    route: RouteBinding,
    message: AgentMessage,
    ctx: CallContext,
  ): Promise<MessageReceipt> {
    validateAgentMessage(message);
    const trusted: AgentMessage = {
      ...message,
      tenantId: ctx.caller.tenantId,
      actor: { principalId: ctx.caller.id, principalType: ctx.caller.type },
    };
    const result = await this.call<{ message?: A2AMessage }>(
      route.target.endpoint!,
      'SendMessage',
      {
        message: {
          role: 'ROLE_USER',
          messageId: message.messageId,
          contextId: message.correlationId,
          parts: [{ text: message.name }],
          metadata: { 'agentropy/envelope': trusted },
        } satisfies A2AMessage,
      },
      ctx,
    );
    const ack = result?.message?.parts?.[0]?.text;
    return {
      messageId: message.messageId,
      accepted: ack
        ? (JSON.parse(ack) as { accepted: boolean }).accepted
        : false,
    };
  }

  async getTask(
    ref: RemoteTaskRef,
    ctx: CallContext,
  ): Promise<RemoteTaskState> {
    return this.state(
      await this.call<A2ATask>(
        ref.route.target.endpoint!,
        'GetTask',
        { id: ref.remoteTaskId },
        ctx,
      ),
    );
  }

  async cancel(ref: RemoteTaskRef, ctx: CallContext): Promise<RemoteTaskState> {
    return this.state(
      await this.call<A2ATask>(
        ref.route.target.endpoint!,
        'CancelTask',
        { id: ref.remoteTaskId },
        ctx,
      ),
    );
  }

  async *subscribe(
    ref: RemoteTaskRef,
    ctx: CallContext,
  ): AsyncIterable<AgentEvent> {
    let last: A2ATaskState | undefined;
    let revision = 0;
    for (let polls = 0; ; polls++) {
      const t = await this.call<A2ATask>(
        ref.route.target.endpoint!,
        'GetTask',
        { id: ref.remoteTaskId },
        ctx,
      );
      if (t.status.state !== last) {
        last = t.status.state;
        revision++;
        yield {
          eventId: `${ref.remoteTaskId}:${revision}`,
          taskId: ref.remoteTaskId,
          type: 'taskStatusChanged',
          revision,
          payload: {
            status: FROM_A2A[t.status.state] ?? 'unknown',
            remoteState: t.status.state,
          },
        };
      }
      if (
        TERMINAL_A2A.has(t.status.state) ||
        polls >= (this.o.maxPolls ?? Infinity)
      )
        return;
      await new Promise((r) => setTimeout(r, this.o.pollMs ?? 1_000));
    }
  }
}

/** Minimal A2A AgentCard for an endpoint (spec section 8); serve it at the well-known path. */
export function a2aAgentCard(o: {
  name: string;
  description: string;
  version: string;
  url: string;
  securitySchemes?: Record<string, unknown>;
  security?: Record<string, string[]>[];
  skills?: { id: string; name: string; description: string; tags?: string[] }[];
}): Record<string, unknown> {
  return {
    name: o.name,
    description: o.description,
    version: o.version,
    supportedInterfaces: [
      {
        url: o.url,
        protocolBinding: 'JSONRPC',
        protocolVersion: A2A_PROTOCOL_VERSION,
      },
    ],
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ['text/plain', 'application/json'],
    defaultOutputModes: ['text/plain', 'application/json'],
    ...(o.securitySchemes ? { securitySchemes: o.securitySchemes } : {}),
    ...(o.security ? { security: o.security } : {}),
    skills: o.skills ?? [],
  };
}
