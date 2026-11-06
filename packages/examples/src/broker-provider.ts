/**
 * Custom Communication provider sample (C-04): agents reached through a message broker / RPC fabric, without a
 * broker dependency in Agentropy. Replace `InMemoryBroker` with an adapter for NATS, RabbitMQ, Kafka request-reply,
 * gRPC or anything else that can do request/response on a topic.
 *
 * Identity: a production broker authenticates producers (mTLS, tokens) and stamps that identity on each request;
 * the in-memory broker models this by carrying the principal the *provider's process* authenticated as, never a
 * value taken from the payload. The serving side uses only that stamped principal.
 */
import {
  AgentropyError,
  toAgentropyError,
  validateAgentMessage,
  type AgentCommunicationProvider,
  type AgentEvent,
  type AgentMessage,
  type AgentRef,
  type CallContext,
  type CommunicationFeatures,
  type CommunicationOperation,
  type DelegationRequest,
  type MessageReceipt,
  type RemoteTaskRef,
  type RemoteTaskState,
  type RouteBinding,
  type TaskSnapshot,
  type TrustedPrincipal,
} from '@agentropy/core';
import type { DirectTarget } from '@agentropy/runtime';

/** The only thing the provider needs from a broker. */
export interface Broker {
  request(
    topic: string,
    payload: string,
    stamp: { principal: TrustedPrincipal },
  ): Promise<string>;
}

type Handler = (
  payload: string,
  stamp: { principal: TrustedPrincipal },
) => Promise<string>;

export class InMemoryBroker implements Broker {
  private readonly handlers = new Map<string, Handler>();
  serve(topic: string, handler: Handler): void {
    this.handlers.set(topic, handler);
  }
  async request(
    topic: string,
    payload: string,
    stamp: { principal: TrustedPrincipal },
  ): Promise<string> {
    const h = this.handlers.get(topic);
    if (!h)
      throw new AgentropyError('RemoteUnavailable', `No consumer on ${topic}`);
    // Serialize both ways, as a real wire would.
    return h(String(payload), structuredClone(stamp));
  }
}

type Request =
  | { op: 'delegate'; request: DelegationRequest }
  | { op: 'send'; message: AgentMessage }
  | { op: 'getTask' | 'cancel' | 'subscribe'; taskId: string };

/** Serving side: bridges broker requests to a DirectTarget (e.g. `localAppTarget(app)`). */
export function serveOnBroker(
  broker: InMemoryBroker,
  topic: string,
  target: DirectTarget,
  /** The local instance this topic exposes (like the A2A server's `instanceId`). */
  options: { instanceId?: string } = {},
): void {
  broker.serve(topic, async (payload, { principal }) => {
    try {
      const req = JSON.parse(payload) as Request;
      switch (req.op) {
        case 'delegate':
          return JSON.stringify({
            ok: await target.delegate(
              options.instanceId
                ? { ...req.request, target: { instanceId: options.instanceId } }
                : req.request,
              principal,
            ),
          });
        case 'send': {
          const m = validateAgentMessage(req.message);
          const trusted = {
            ...m,
            tenantId: principal.tenantId,
            actor: { principalId: principal.id, principalType: principal.type },
          };
          return JSON.stringify({
            ok: await target.receive(trusted, principal),
          });
        }
        case 'getTask':
          return JSON.stringify({
            ok: await target.getTask(req.taskId, principal),
          });
        case 'cancel':
          return JSON.stringify({
            ok: await target.cancel(req.taskId, principal),
          });
        case 'subscribe': {
          const events: AgentEvent[] = [];
          for await (const e of target.subscribe(req.taskId, principal))
            events.push(e);
          return JSON.stringify({ ok: events });
        }
      }
    } catch (err) {
      return JSON.stringify({ error: toAgentropyError(err).toJSON() });
    }
  });
}

export class BrokerCommunicationProvider implements AgentCommunicationProvider {
  readonly id = 'broker-sample';
  readonly features: CommunicationFeatures = {
    operations: ['delegate', 'send', 'getTask', 'cancel', 'subscribe'],
    streaming: false,
    pushNotifications: false,
    durability: 'provider-dependent',
    protocol: 'broker-rpc',
    protocolVersion: '1',
  };

  constructor(
    private readonly broker: Broker,
    /** Topic per target, e.g. `agents.<tenant>.<definition>`. */
    private readonly topicFor: (target: AgentRef) => string,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  supports(target: AgentRef, operation: CommunicationOperation): boolean {
    return (
      target.endpoint?.startsWith('broker:') === true &&
      this.features.operations.includes(operation)
    );
  }

  private async rpc<T>(
    target: AgentRef,
    req: Request,
    ctx: CallContext,
  ): Promise<T> {
    const reply = JSON.parse(
      await this.broker.request(this.topicFor(target), JSON.stringify(req), {
        principal: ctx.caller,
      }),
    ) as { ok?: T; error?: { code: string; message: string } };
    if (reply.error)
      throw new AgentropyError(reply.error.code as never, reply.error.message, {
        details: { protocol: 'broker-rpc' },
      });
    return reply.ok as T;
  }

  private state(s: TaskSnapshot & { output?: unknown }): RemoteTaskState {
    return {
      remoteState: s.status,
      normalized: s.status,
      observedAt: this.now(),
      ...(s.output !== undefined ? { output: s.output } : {}),
    };
  }

  async delegate<I>(
    route: RouteBinding,
    request: DelegationRequest<I>,
    ctx: CallContext,
  ): Promise<RemoteTaskRef> {
    const { taskId } = await this.rpc<{ taskId: string }>(
      route.target,
      { op: 'delegate', request },
      ctx,
    );
    return { localTaskId: `broker:${taskId}`, route, remoteTaskId: taskId };
  }

  async send(
    route: RouteBinding,
    message: AgentMessage,
    ctx: CallContext,
  ): Promise<MessageReceipt> {
    const { accepted } = await this.rpc<{ accepted: boolean }>(
      route.target,
      { op: 'send', message },
      ctx,
    );
    return { messageId: message.messageId, accepted };
  }

  async getTask(
    ref: RemoteTaskRef,
    ctx: CallContext,
  ): Promise<RemoteTaskState> {
    return this.state(
      await this.rpc<TaskSnapshot>(
        ref.route.target,
        { op: 'getTask', taskId: ref.remoteTaskId },
        ctx,
      ),
    );
  }

  async cancel(ref: RemoteTaskRef, ctx: CallContext): Promise<RemoteTaskState> {
    return this.state(
      await this.rpc<TaskSnapshot>(
        ref.route.target,
        { op: 'cancel', taskId: ref.remoteTaskId },
        ctx,
      ),
    );
  }

  async *subscribe(
    ref: RemoteTaskRef,
    ctx: CallContext,
  ): AsyncIterable<AgentEvent> {
    yield* await this.rpc<AgentEvent[]>(
      ref.route.target,
      { op: 'subscribe', taskId: ref.remoteTaskId },
      ctx,
    );
  }
}
