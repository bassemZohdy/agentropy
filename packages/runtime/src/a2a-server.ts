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
    /** Aborting ends the stream and releases its subscription (e.g. when the HTTP client goes away). */
    options?: { signal?: AbortSignal },
  ): Promise<A2AStreamResult>;
  /** Resolves once every push watcher has finished (their tasks reached a terminal state or configs were deleted). */
  pushIdle(): Promise<void>;
  /**
   * With `push.store`: restarts delivery for stored configs whose tasks are still live (call once at start).
   * Returns how many watchers were started.
   */
  resumePush(): Promise<number>;
}

const STREAMING_METHODS = new Set(['SendStreamingMessage', 'SubscribeToTask']);

const PUSH_METHODS = new Set([
  'CreateTaskPushNotificationConfig',
  'GetTaskPushNotificationConfig',
  'ListTaskPushNotificationConfigs',
  'DeleteTaskPushNotificationConfig',
]);

/** A2A state of a task: waiting on a human action is `INPUT_REQUIRED`, other waits are `WORKING`. */
export function a2aState(s: TaskSnapshot): A2ATaskState {
  return s.status === 'waiting' &&
    s.waitingOn?.anyOf.some((c) => c.kind === 'human-action')
    ? 'TASK_STATE_INPUT_REQUIRED'
    : TO_A2A[s.status];
}

/** `ListTasks` page size: default and maximum (A2A 1.0 section 3.1.4). */
const LIST_DEFAULT = 50;
const LIST_MAX = 100;
/** Visible tasks scanned for one `ListTasks` call. */
const LIST_SCAN = 10_000;

const A2A_STATES = new Set<string>([
  'TASK_STATE_SUBMITTED',
  'TASK_STATE_WORKING',
  'TASK_STATE_INPUT_REQUIRED',
  'TASK_STATE_AUTH_REQUIRED',
  'TASK_STATE_COMPLETED',
  'TASK_STATE_FAILED',
  'TASK_STATE_CANCELED',
  'TASK_STATE_REJECTED',
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
    ...((contextId ?? s.correlationId)
      ? { contextId: contextId ?? s.correlationId }
      : {}),
    status: { state: a2aState(s), timestamp: s.updatedAt ?? now() },
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
    return m;
  };
  /**
   * A message with `taskId` continues that task (A2A 1.0 section 3.4): it must exist and be visible, must not be
   * terminal, its `contextId` (when given) must match the task's, and the task must be waiting for input.
   */
  const continueMessage = async (
    m: A2AMessage,
    principal: TrustedPrincipal,
  ): Promise<TaskSnapshot> => {
    const taskId = m.taskId!;
    const snap = await target.getTask(taskId, principal);
    if (TERMINAL_A2A.has(TO_A2A[snap.status]))
      throw new AgentropyError(
        'UnsupportedOperation',
        'Task is in a terminal state',
      );
    if (m.contextId && snap.correlationId && m.contextId !== snap.correlationId)
      throw new AgentropyError(
        'SchemaViolation',
        'contextId does not match the task',
        { details: { reason: 'contextId' } },
      );
    if (!target.continueTask)
      throw new AgentropyError(
        'UnsupportedOperation',
        'Continuing a task is not supported',
      );
    await target.continueTask(
      taskId,
      decodeParts(m.parts),
      m.messageId,
      principal,
    );
    return target.getTask(taskId, principal);
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
    signal?: AbortSignal,
  ): AsyncIterable<A2AStreamFrame> {
    const frame = (result: unknown): A2AStreamFrame => ({
      jsonrpc: '2.0',
      id,
      result,
    });
    const taskId = first.taskId;
    // TaskStatusUpdateEvent/TaskArtifactUpdateEvent require context_id; without one the task ID stands in.
    const ctx = { contextId: contextId ?? taskId };
    let last = a2aState(first);
    yield frame({ task: task(first, contextId) });
    if (TERMINAL_A2A.has(last)) return;
    /** Frames for a newly observed local status; none when it is not forward progress. */
    async function* advance(
      status: string | undefined,
    ): AsyncIterable<A2AStreamFrame> {
      if (!status || !(status in TO_A2A)) return;
      // A wait may be for input: the task tells which.
      const state =
        status === 'waiting'
          ? a2aState(await target.getTask(taskId, principal))
          : TO_A2A[status as TaskSnapshot['status']];
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
      for await (const e of target.subscribe(
        taskId,
        principal,
        signal ? { signal } : undefined,
      )) {
        yield* advance((e.payload as { status?: string } | undefined)?.status);
        if (TERMINAL_A2A.has(last)) return;
      }
      if (signal?.aborted) return;
      // The event stream can end without its terminal event (e.g. compacted events): reconcile with the task.
      yield* advance((await target.getTask(taskId, principal)).status);
    } catch (err) {
      // An error after the stream opened ends it with a JSON-RPC error frame.
      yield mapped(id, err).body;
    }
  }
  /**
   * A2A `ListTasks` over the tasks the caller may see on this endpoint: filtered by `contextId`, `status` and
   * `statusTimestampAfter`, newest status first, with a cursor (status timestamp and task ID of the last task).
   * History is not kept, so `historyLength` has no effect; artifacts only with `includeArtifacts`.
   */
  const listTasks = async (
    p: Record<string, unknown>,
    caller: TrustedPrincipal,
  ) => {
    if (!target.listTasks)
      throw new AgentropyError(
        'UnsupportedOperation',
        'ListTasks is not supported',
      );
    const bad = (field: string) =>
      new AgentropyError('SchemaViolation', `Invalid ${field}`, {
        details: { reason: field },
      });
    const size = p['pageSize'] === undefined ? LIST_DEFAULT : p['pageSize'];
    if (
      !Number.isInteger(size) ||
      (size as number) < 1 ||
      (size as number) > LIST_MAX
    )
      throw bad('pageSize');
    const status = p['status'];
    if (
      status !== undefined &&
      (typeof status !== 'string' || !A2A_STATES.has(status))
    )
      throw bad('status');
    const contextId = p['contextId'];
    if (contextId !== undefined && typeof contextId !== 'string')
      throw bad('contextId');
    const afterRaw = p['statusTimestampAfter'];
    const after =
      afterRaw === undefined ? undefined : Date.parse(String(afterRaw));
    if (after !== undefined && Number.isNaN(after))
      throw bad('statusTimestampAfter');
    let from: [string, string] | undefined;
    if (p['pageToken'] !== undefined && p['pageToken'] !== '') {
      try {
        from = JSON.parse(
          Buffer.from(String(p['pageToken']), 'base64url').toString('utf8'),
        ) as [string, string];
        if (!Array.isArray(from) || from.some((x) => typeof x !== 'string'))
          throw new Error();
      } catch {
        throw bad('pageToken');
      }
    }
    const visible: TaskSnapshot[] = [];
    let cursor: string | undefined;
    while (visible.length < LIST_SCAN) {
      const r = await target.listTasks(
        {
          ...(o.instanceId ? { instanceId: o.instanceId } : {}),
          ...(cursor ? { cursor } : {}),
          limit: 200,
        },
        caller,
      );
      visible.push(...r.tasks);
      if (r.tasks.length < 200) break;
      cursor = r.cursor;
    }
    const at = (t: TaskSnapshot) => t.updatedAt ?? '';
    // Newest status first; ties by task ID, descending, so the cursor is a total order.
    const newer = (a: [string, string], b: [string, string]) =>
      a[0] !== b[0] ? a[0] > b[0] : a[1] > b[1];
    const matching = visible
      .filter(
        (t) =>
          (contextId === undefined || t.correlationId === contextId) &&
          (status === undefined || a2aState(t) === status) &&
          (after === undefined || Date.parse(at(t)) >= after),
      )
      .sort((a, b) => (newer([at(a), a.taskId], [at(b), b.taskId]) ? -1 : 1));
    const rest = from
      ? matching.filter((t) => newer(from!, [at(t), t.taskId]))
      : matching;
    const page = rest.slice(0, size as number);
    const tasks = await Promise.all(
      page.map(async (t) => {
        if (p['includeArtifacts'] === true && t.status === 'completed')
          return task(await target.getTask(t.taskId, caller));
        const { artifacts: _omit, ...plain } = task(t);
        void _omit;
        return plain;
      }),
    );
    const last = page.at(-1);
    return {
      tasks,
      nextPageToken:
        last && rest.length > page.length
          ? Buffer.from(JSON.stringify([at(last), last.taskId])).toString(
              'base64url',
            )
          : '',
      pageSize: size,
      totalSize: matching.length,
    };
  };
  const notifications = createPushNotifications(target, o.push, follow);
  return {
    pushIdle: () => notifications.idle(),
    resumePush: () => notifications.resume(),
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
            const snap = m.taskId
              ? await continueMessage(m, caller)
              : await target.getTask(await delegateMessage(m, caller), caller);
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
          case 'ListTasks':
            return {
              status: 200,
              body: { jsonrpc: '2.0', id, result: await listTasks(p, caller) },
            };
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

    async stream(raw, principal, headers = {}, options = {}) {
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
            const first = m.taskId
              ? await continueMessage(m, caller)
              : await target.getTask(await delegateMessage(m, caller), caller);
            return {
              kind: 'stream',
              status: 200,
              frames: follow(id, first, caller, m.contextId, options.signal),
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
              frames: follow(id, first, caller, undefined, options.signal),
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
    listTasks: (query, caller) => app.listTasks(query, caller),
    continueTask: async (taskId, input, messageId, caller) => {
      const snap = await app.getTask(taskId, caller);
      const wait = snap.waitingOn?.anyOf.find((c) => c.kind === 'human-action');
      if (snap.status !== 'waiting' || !wait || wait.kind !== 'human-action')
        throw new AgentropyError(
          'UnsupportedOperation',
          'Task is not waiting for input',
        );
      const action = await app.getHumanAction(wait.requestId, caller);
      await app.provideHumanInput(
        {
          requestId: wait.requestId,
          expectedRevision: action.revision,
          input,
          idempotencyKey: messageId,
        },
        caller,
      );
    },
    subscribe: (taskId, caller, options) => {
      const stream = app.subscribe(taskId, caller, undefined, options);
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
