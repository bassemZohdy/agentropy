/**
 * A2A server (inbound): maps A2A JSON-RPC methods onto a `DirectTarget` (e.g. `localAppTarget(app)`) with the
 * principal produced by the transport's authentication, reusing the AgentService PEPs. `stream` serves
 * `SendStreamingMessage` and `SubscribeToTask` (FEAT-029.1); `push` options enable push notifications (FEAT-029.2).
 */
import {
  AgentropyError,
  toAgentropyError,
  validateAgentMessage,
  type AgentEvent,
  type TaskSnapshot,
  type TrustedPrincipal,
} from '@agentropy/core';
import type { LocalApp } from './app.js';
import type { DirectTarget } from './communication.js';
import {
  A2A_PROTOCOL_VERSION,
  TERMINAL_A2A,
  TO_A2A,
  decodeParts,
  encodeInput,
  toA2ACode,
  type A2AMessage,
  type A2ATask,
  type A2ATaskState,
} from './a2a-protocol.js';
import { createPushNotifications, type A2APushOptions } from './a2a-push.js';

export interface A2AServerOptions {
  /** The local agent instance this endpoint exposes (passed to the target as `target.instanceId`). */
  instanceId?: string;
  now?: () => string;
  /** Enables the push-notification config methods (FEAT-029.2); without it they answer -32003. */
  push?: A2APushOptions;
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

/** One frame of a streaming response: a JSON-RPC response whose `result` is an A2A `StreamResponse`. */
export type A2AStreamFrame = A2AHttpResponse['body'];

/** A streaming call either fails up front (a plain JSON-RPC response) or opens an event stream. */
export type A2AStreamResult =
  | { kind: 'error'; response: A2AHttpResponse }
  | { kind: 'stream'; status: 200; frames: AsyncIterable<A2AStreamFrame> };

export interface A2AServer {
  /** Unary methods: `SendMessage`, `GetTask`, `CancelTask`. */
  handle(
    request: unknown,
    principal: TrustedPrincipal | undefined,
    headers?: { 'a2a-version'?: string },
  ): Promise<A2AHttpResponse>;
  /**
   * Streaming methods: `SendStreamingMessage` and `SubscribeToTask`. The first frame is the task; status and
   * artifact updates follow, and the stream ends after the terminal status. Serve the frames with `sseFrames`.
   */
  stream(
    request: unknown,
    principal: TrustedPrincipal | undefined,
    headers?: { 'a2a-version'?: string },
  ): Promise<A2AStreamResult>;
  /** Resolves once every push watcher has finished (their tasks reached a terminal state or configs were deleted). */
  pushIdle(): Promise<void>;
}

const STREAMING_METHODS = new Set(['SendStreamingMessage', 'SubscribeToTask']);

const PUSH_METHODS = new Set([
  'CreateTaskPushNotificationConfig',
  'GetTaskPushNotificationConfig',
  'ListTaskPushNotificationConfigs',
  'DeleteTaskPushNotificationConfig',
]);

/** Progress rank: a stream never reports a state behind one it already reported. */
const RANK = (s: A2ATaskState): number =>
  s === 'TASK_STATE_SUBMITTED' ? 0 : TERMINAL_A2A.has(s) ? 2 : 1;

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
  type Req = {
    jsonrpc?: string;
    id?: unknown;
    method?: string;
    params?: Record<string, unknown>;
  };
  const failure = (
    id: unknown,
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
  const mapped = (id: unknown, err: unknown): A2AHttpResponse => {
    const e = toAgentropyError(err);
    const a2a = (e.details?.['a2a'] as number | undefined) ?? toA2ACode(e.code);
    return failure(id, 200, a2a, e);
  };
  /** Authentication, version and request-shape checks shared by unary and streaming calls. */
  const precheck = (
    req: Req,
    principal: TrustedPrincipal | undefined,
    headers: { 'a2a-version'?: string },
  ): A2AHttpResponse | undefined => {
    const id = req?.id ?? null;
    if (!principal?.id || !principal.tenantId)
      return failure(
        id,
        401,
        -32600,
        new AgentropyError('Unauthenticated', 'Authentication required'),
      );
    const version = headers['a2a-version'];
    if (version !== undefined && version !== A2A_PROTOCOL_VERSION)
      return failure(
        id,
        200,
        -32009,
        new AgentropyError(
          'IncompatibleVersion',
          `A2A version ${version} is not supported`,
          { details: { supported: A2A_PROTOCOL_VERSION } },
        ),
      );
    if (req?.jsonrpc !== '2.0' || typeof req.method !== 'string')
      return failure(
        id,
        200,
        -32600,
        new AgentropyError('SchemaViolation', 'Invalid JSON-RPC request'),
      );
    return undefined;
  };
  const userMessage = (p: Record<string, unknown>): A2AMessage => {
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
    return m;
  };
  const delegateMessage = async (
    m: A2AMessage,
    principal: TrustedPrincipal,
  ): Promise<string> => {
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
    return taskId;
  };
  /** Task frame, then forward-only status updates (the output artifact precedes `completed`) until terminal. */
  async function* follow(
    id: unknown,
    first: TaskSnapshot,
    principal: TrustedPrincipal,
    contextId?: string,
  ): AsyncIterable<A2AStreamFrame> {
    const frame = (result: unknown): A2AStreamFrame => ({
      jsonrpc: '2.0',
      id,
      result,
    });
    const taskId = first.taskId;
    // TaskStatusUpdateEvent/TaskArtifactUpdateEvent require context_id; without one the task ID stands in.
    const ctx = { contextId: contextId ?? taskId };
    let last = TO_A2A[first.status];
    yield frame({ task: task(first, contextId) });
    if (TERMINAL_A2A.has(last)) return;
    /** Frames for a newly observed local status; none when it is not forward progress. */
    async function* advance(
      status: string | undefined,
    ): AsyncIterable<A2AStreamFrame> {
      if (!status || !(status in TO_A2A)) return;
      const state = TO_A2A[status as TaskSnapshot['status']];
      if (state === last || RANK(state) < RANK(last)) return;
      last = state;
      if (state === 'TASK_STATE_COMPLETED') {
        const done = task(await target.getTask(taskId, principal), contextId);
        for (const artifact of done.artifacts ?? [])
          yield frame({
            artifactUpdate: {
              taskId,
              ...ctx,
              artifact,
              append: false,
              lastChunk: true,
            },
          });
      }
      yield frame({
        statusUpdate: { taskId, ...ctx, status: { state, timestamp: now() } },
      });
    }
    try {
      for await (const e of target.subscribe(taskId, principal)) {
        yield* advance((e.payload as { status?: string } | undefined)?.status);
        if (TERMINAL_A2A.has(last)) return;
      }
      // The event stream can end without its terminal event (e.g. compacted events): reconcile with the task.
      yield* advance((await target.getTask(taskId, principal)).status);
    } catch (err) {
      // An error after the stream opened ends it with a JSON-RPC error frame.
      yield mapped(id, err).body;
    }
  }
  const notifications = createPushNotifications(target, o.push, follow);
  return {
    pushIdle: () => notifications.idle(),
    async handle(raw, principal, headers = {}) {
      const req = raw as Req;
      const id = req?.id ?? null;
      const rejected = precheck(req, principal, headers);
      if (rejected) return rejected;
      const caller = principal!;
      try {
        const p = req.params ?? {};
        switch (req.method) {
          case 'SendMessage': {
            const m = userMessage(p);
            const envelope = m.metadata?.['agentropy/envelope'];
            if (envelope !== undefined) {
              // Agentropy envelope: identity always comes from the transport principal.
              const msg = validateAgentMessage(envelope);
              const { accepted } = await target.receive(
                {
                  ...msg,
                  tenantId: caller.tenantId,
                  actor: {
                    principalId: caller.id,
                    principalType: caller.type,
                  },
                },
                caller,
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
            const taskId = await delegateMessage(m, caller);
            const snap = await target.getTask(taskId, caller);
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
            const snap = await target.getTask(p['id'], caller);
            return {
              status: 200,
              body: { jsonrpc: '2.0', id, result: task(snap) },
            };
          }
          case 'CancelTask': {
            if (typeof p['id'] !== 'string')
              throw new AgentropyError('SchemaViolation', 'id required');
            const snap = await target.cancel(p['id'], caller);
            return {
              status: 200,
              body: { jsonrpc: '2.0', id, result: task(snap) },
            };
          }
          default:
            if (PUSH_METHODS.has(req.method!))
              return {
                status: 200,
                body: {
                  jsonrpc: '2.0',
                  id,
                  result: await notifications.method(req.method!, p, caller),
                },
              };
            if (STREAMING_METHODS.has(req.method!))
              throw new AgentropyError(
                'UnsupportedOperation',
                `Method ${req.method} needs the streaming transport`,
              );
            return failure(
              id,
              200,
              -32601,
              new AgentropyError(
                'UnsupportedOperation',
                `Method ${req.method} not supported`,
              ),
            );
        }
      } catch (err) {
        return mapped(id, err);
      }
    },

    async stream(raw, principal, headers = {}) {
      const req = raw as Req;
      const id = req?.id ?? null;
      const rejected = precheck(req, principal, headers);
      if (rejected) return { kind: 'error', response: rejected };
      const caller = principal!;
      try {
        const p = req.params ?? {};
        switch (req.method) {
          case 'SendStreamingMessage': {
            const m = userMessage(p);
            if (m.metadata?.['agentropy/envelope'] !== undefined)
              throw new AgentropyError(
                'UnsupportedOperation',
                'Agentropy envelopes travel as SendMessage',
              );
            const taskId = await delegateMessage(m, caller);
            const first = await target.getTask(taskId, caller);
            return {
              kind: 'stream',
              status: 200,
              frames: follow(id, first, caller, m.contextId),
            };
          }
          case 'SubscribeToTask': {
            if (typeof p['id'] !== 'string')
              throw new AgentropyError('SchemaViolation', 'id required');
            const first = await target.getTask(p['id'], caller);
            // Spec: subscribing to a task in a terminal state is UnsupportedOperationError.
            if (TERMINAL_A2A.has(TO_A2A[first.status]))
              throw new AgentropyError(
                'UnsupportedOperation',
                'Task is in a terminal state',
              );
            return {
              kind: 'stream',
              status: 200,
              frames: follow(id, first, caller),
            };
          }
          default:
            return {
              kind: 'error',
              response: failure(
                id,
                200,
                -32601,
                new AgentropyError(
                  'UnsupportedOperation',
                  `Method ${req.method} is not a streaming method`,
                ),
              ),
            };
        }
      } catch (err) {
        return { kind: 'error', response: mapped(id, err) };
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
