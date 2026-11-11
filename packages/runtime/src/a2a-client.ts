/**
 * A2A client (outbound): `A2ACommunicationProvider` implements the Communication SPI for targets with an
 * `endpoint`, and `a2aAgentCard` builds the AgentCard a server publishes.
 */
import { a2aPushToken } from './a2a-push-receiver.js';
import {
  AgentropyError,
  isAgentropyError,
  isErrorCode,
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
} from '@agentropy/core';
import {
  A2A_ERRORS,
  A2A_PROTOCOL_VERSION,
  FROM_A2A,
  TERMINAL_A2A,
  decodeParts,
  encodeInput,
  type A2AMessage,
  type A2ATask,
  type A2ATaskState,
} from './a2a-protocol.js';
import { sseData } from './a2a-sse.js';

/** The part of a fetch Response the provider reads; `headers` and `body` are needed only for streaming. */
interface FetchResponse {
  status: number;
  json(): Promise<unknown>;
  headers?: { get(name: string): string | null };
  body?: AsyncIterable<Uint8Array | string> | null;
}

type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<FetchResponse>;

/** A2A `StreamResponse`: exactly one of the members is set. */
interface A2AStreamResponse {
  task?: A2ATask;
  message?: A2AMessage;
  statusUpdate?: { taskId: string; status: { state: A2ATaskState } };
  artifactUpdate?: { taskId: string };
}

export interface A2AProviderOptions {
  fetch?: FetchLike;
  /** Credential for this runtime's identity at the peer (resolved per call, sent as a Bearer token). */
  credentialRef?: string;
  credentials?: CredentialProvider;
  now?: () => string;
  /**
   * Use `SubscribeToTask` over SSE for `subscribe` (the peer's AgentCard advertises `capabilities.streaming`).
   * A peer that declines, or a stream that ends before a terminal state, falls back to polling GetTask.
   */
  streaming?: boolean;
  /** Interval between GetTask polls when `subscribe` polls. */
  pollMs?: number;
  /** Polls after the first snapshot before `subscribe` ends without a terminal state (default unlimited). */
  maxPolls?: number;
  /**
   * Registers a webhook at the peer after each delegation (FEAT-048): `CreateTaskPushNotificationConfig` with the URL
   * `<publicUrl><path>/<local task id>` and a per-task HMAC token. Best effort: a peer that refuses or lacks push
   * leaves the delegation as it was and polling carries on. Pair it with `createA2APushReceiver` using the same secret.
   */
  push?: {
    /** Externally reachable base URL of this runtime's receiver: https (unless `allowHttp`), no credentials, query or fragment. */
    publicUrl: string;
    /** Shared secret for the tokens, at least 32 bytes. */
    secret: string;
    /** Path of the receiver below `publicUrl` (default `/a2a/push`). */
    path?: string;
    allowHttp?: boolean;
  };
}

/** Error codes only this runtime may raise about its own authority; from a peer they become `RemoteUnavailable`. */
const LOCAL_ONLY = new Set<string>([
  'AuthorityExpired',
  'PolicyDecisionUnavailable',
]);

/** Validates `push` and returns the base URL a webhook is registered under (no trailing slash). */
function pushBase(p: NonNullable<A2AProviderOptions['push']>): string {
  if (Buffer.byteLength(p.secret, 'utf8') < 32)
    throw new AgentropyError(
      'InvalidConfiguration',
      'push.secret must be at least 32 bytes',
    );
  let u: URL;
  try {
    u = new URL(p.publicUrl);
  } catch {
    throw new AgentropyError(
      'InvalidConfiguration',
      'push.publicUrl is not a URL',
    );
  }
  if (u.protocol !== 'https:' && !(p.allowHttp && u.protocol === 'http:'))
    throw new AgentropyError(
      'InvalidConfiguration',
      'push.publicUrl must be https (or http with allowHttp)',
    );
  if (u.username || u.password || u.search || u.hash)
    throw new AgentropyError(
      'InvalidConfiguration',
      'push.publicUrl must not carry credentials, a query or a fragment',
    );
  const path = (p.path ?? '/a2a/push').replace(/\/+$/, '');
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}${path}`;
}

export class A2ACommunicationProvider implements AgentCommunicationProvider {
  readonly id = 'a2a';
  readonly features: CommunicationFeatures;
  private seq = 0;
  private readonly pushUrl: string | undefined;

  constructor(private readonly o: A2AProviderOptions = {}) {
    this.pushUrl = o.push ? pushBase(o.push) : undefined;
    this.features = {
      operations: ['delegate', 'send', 'getTask', 'cancel', 'subscribe'],
      streaming: o.streaming === true,
      pushNotifications: o.push !== undefined,
      durability: 'provider-dependent',
      protocol: 'a2a',
      protocolVersion: A2A_PROTOCOL_VERSION,
    };
  }

  supports(target: AgentRef, operation: CommunicationOperation): boolean {
    return !!target.endpoint && this.features.operations.includes(operation);
  }

  private async call<T>(
    endpoint: string,
    method: string,
    params: unknown,
    ctx: CallContext,
  ): Promise<T> {
    const res = await this.post(endpoint, method, params, ctx);
    return this.result<T>(await res.json());
  }

  private async post(
    endpoint: string,
    method: string,
    params: unknown,
    ctx: CallContext,
    accept = 'application/json',
  ): Promise<FetchResponse> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept,
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
    let res: FetchResponse;
    try {
      res = await (
        this.o.fetch ??
        ((u, i) => fetch(u, i) as unknown as Promise<FetchResponse>)
      )(endpoint, {
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
    // An error reply's body is never read: release its connection (a real fetch Response holds it until read).
    if (res.status === 401 || res.status === 403 || res.status >= 500)
      void (res.body as { cancel?: () => Promise<unknown> } | null | undefined)
        ?.cancel?.()
        ?.catch(() => undefined);
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
    return res;
  }

  /** The JSON-RPC result, or the peer's error mapped to a typed code. */
  private result<T>(raw: unknown): T {
    const body = raw as {
      result?: T;
      error?: {
        code?: number;
        data?: { code?: string; details?: Record<string, unknown> };
      };
    };
    if (body.error) {
      // Prefer an Agentropy peer's typed code; otherwise map the A2A code. Remote messages are not trusted text.
      const fromPeer = body.error.data?.code;
      const peerCode =
        fromPeer && isErrorCode(fromPeer)
          ? fromPeer
          : (A2A_ERRORS[body.error.code ?? 0] ?? 'RemoteUnavailable');
      // Lost authority and a policy outage mean something to the local runtime (a task parks behind the dispatch
      // gate). A peer's claim of them is about the peer, never about local authority (FEAT-038.4).
      const code = LOCAL_ONLY.has(peerCode) ? 'RemoteUnavailable' : peerCode;
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
    const parts = t.artifacts?.[0]?.parts;
    let output: unknown;
    if (t.status.state === 'TASK_STATE_COMPLETED' && parts?.length === 1) {
      try {
        output = decodeParts(parts);
      } catch {
        output = undefined; // an unreadable artifact is not a result
      }
    }
    return {
      remoteState: t.status.state,
      normalized: FROM_A2A[t.status.state] ?? 'unknown',
      observedAt: this.now(),
      ...(output !== undefined ? { output } : {}),
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
    const localTaskId = `a2a:${result.task.id}`;
    if (this.o.push && this.pushUrl)
      try {
        // A hint on top of polling: any failure (no push at the peer, a refusal, the network) is ignored.
        await this.call(
          endpoint,
          'CreateTaskPushNotificationConfig',
          {
            taskId: result.task.id,
            id: 'agentropy',
            url: `${this.pushUrl}/${encodeURIComponent(localTaskId)}`,
            token: a2aPushToken(this.o.push.secret, localTaskId),
          },
          ctx,
        );
      } catch {
        // polling stays the fallback
      }
    return { localTaskId, route, remoteTaskId: result.task.id };
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
    let accepted = false;
    if (ack) {
      try {
        accepted =
          (JSON.parse(ack) as { accepted?: unknown }).accepted === true;
      } catch {
        throw new AgentropyError(
          'RemoteUnavailable',
          'A2A peer sent an unreadable acknowledgement',
          { details: { protocol: 'a2a' } },
        );
      }
    }
    return { messageId: message.messageId, accepted };
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
    const observe = (state: A2ATaskState): AgentEvent | undefined => {
      if (state === last) return undefined;
      last = state;
      revision++;
      return {
        eventId: `${ref.remoteTaskId}:${revision}`,
        taskId: ref.remoteTaskId,
        type: 'taskStatusChanged',
        revision,
        payload: {
          status: FROM_A2A[state] ?? 'unknown',
          remoteState: state,
        },
      };
    };
    if (this.o.streaming) {
      for await (const state of this.streamStates(ref, ctx)) {
        const e = observe(state);
        if (e) yield e;
        if (TERMINAL_A2A.has(state)) return;
      }
      // Declined or ended early: the polling loop below continues from the last observed state.
    }
    for (let polls = 0; ; polls++) {
      const t = await this.call<A2ATask>(
        ref.route.target.endpoint!,
        'GetTask',
        { id: ref.remoteTaskId },
        ctx,
      );
      const e = observe(t.status.state);
      if (e) yield e;
      if (
        TERMINAL_A2A.has(t.status.state) ||
        polls >= (this.o.maxPolls ?? Infinity)
      )
        return;
      await new Promise((r) => setTimeout(r, this.o.pollMs ?? 1_000));
    }
  }

  /**
   * Task states from `SubscribeToTask` over SSE. Ends without a terminal state when the peer does not stream
   * (UnsupportedOperation, or a non-SSE reply) or the stream breaks; typed peer errors (NotFound, …) are thrown.
   */
  private async *streamStates(
    ref: RemoteTaskRef,
    ctx: CallContext,
  ): AsyncIterable<A2ATaskState> {
    let res: FetchResponse;
    try {
      res = await this.post(
        ref.route.target.endpoint!,
        'SubscribeToTask',
        { id: ref.remoteTaskId },
        ctx,
        'text/event-stream',
      );
      if (
        !res.body ||
        !(res.headers?.get('content-type') ?? '').includes('text/event-stream')
      ) {
        this.result(await res.json()); // a JSON reply is an error (or a peer that ignored the method)
        return;
      }
    } catch (err) {
      if (isAgentropyError(err) && err.code === 'UnsupportedOperation') return;
      throw err;
    }
    try {
      for await (const data of sseData(res.body)) {
        let frame: unknown;
        try {
          frame = JSON.parse(data);
        } catch {
          return; // malformed frame: stop trusting the stream, poll instead
        }
        const r = this.result<A2AStreamResponse>(frame);
        const state = r?.task?.status?.state ?? r?.statusUpdate?.status?.state;
        if (state && state in FROM_A2A) yield state;
      }
    } catch (err) {
      if (isAgentropyError(err)) throw err;
      // Transport break mid-stream: fall back to polling.
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
  /** Advertise SSE streaming (`SendStreamingMessage`, `SubscribeToTask`); serve `A2AServer.stream` when set. */
  streaming?: boolean;
  /** Advertise push notifications; set only when the server has `push` options. */
  pushNotifications?: boolean;
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
    capabilities: {
      streaming: o.streaming === true,
      pushNotifications: o.pushNotifications === true,
    },
    defaultInputModes: ['text/plain', 'application/json'],
    defaultOutputModes: ['text/plain', 'application/json'],
    ...(o.securitySchemes ? { securitySchemes: o.securitySchemes } : {}),
    ...(o.security ? { security: o.security } : {}),
    skills: o.skills ?? [],
  };
}
