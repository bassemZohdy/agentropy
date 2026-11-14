/** Communication v1 revision 4: router and the internal direct provider (M1-11, R-31). */
import {
  validateAgentMessage,
  AgentropyError,
  DURABILITY_LEVELS,
  enforcePolicy,
  type AgentCommunicationProvider,
  type AgentEvent,
  type AgentMessage,
  type AgentRef,
  type CallContext,
  type CommunicationFeatures,
  type CommunicationOperation,
  type CommunicationRouter,
  type DelegationRequest,
  type DurabilityLevel,
  type MessageReceipt,
  type PolicyDecisionPoint,
  type RemoteTaskRef,
  type RemoteTaskState,
  type RouteBinding,
  type RouteRequirements,
  type TaskSnapshot,
  type TrustedPrincipal,
} from '@agentropy/core';

const rank = (d: CommunicationFeatures['durability'] | DurabilityLevel) =>
  d === 'provider-dependent' ? 0 : DURABILITY_LEVELS.indexOf(d);

export class DefaultCommunicationRouter implements CommunicationRouter {
  private readonly providers = new Map<string, AgentCommunicationProvider>();

  /** An optional PDP adds a `communication:<operation>` check on the target agent before route selection. */
  constructor(private readonly pdp?: PolicyDecisionPoint) {}

  register(provider: AgentCommunicationProvider): void {
    if (
      this.providers.has(provider.id) &&
      this.providers.get(provider.id) !== provider
    ) {
      throw new AgentropyError(
        'InvalidConfiguration',
        `Communication provider ${provider.id} already registered`,
        { details: { reason: 'duplicate' } },
      );
    }
    this.providers.set(provider.id, provider);
  }

  async selectRoute(
    target: AgentRef,
    operation: CommunicationOperation,
    ctx: CallContext,
    requirements: RouteRequirements = {},
  ): Promise<RouteBinding> {
    // Tenant and authorization come before any route is considered (no provider is told about a forbidden target).
    if (target.tenantId !== ctx.caller.tenantId)
      throw new AgentropyError('TenantMismatch', 'Cross-tenant route denied', {
        details: { operation },
      });
    if (this.pdp) {
      await enforcePolicy(
        this.pdp,
        {
          principal: ctx.caller,
          action: `communication:${operation}`,
          resource: {
            type: 'agent',
            id: target.definitionId,
            tenantId: target.tenantId,
          },
        },
        ctx.signal,
      );
    }
    const ops = new Set([operation, ...(requirements.operations ?? [])]);
    const all = [...this.providers.values()].sort((a, b) =>
      a.id.localeCompare(b.id),
    );
    const reachable = all.filter((p) => p.supports(target, operation));
    if (reachable.length === 0)
      throw new AgentropyError(
        'NoCompatibleRoute',
        'No provider can reach the target',
        { details: { operation } },
      );
    const withOps = reachable.filter((p) =>
      [...ops].every((o) => p.features.operations.includes(o)),
    );
    if (withOps.length === 0)
      throw new AgentropyError(
        'UnsupportedOperation',
        `No provider declares ${[...ops].join(', ')}`,
        { details: { operation } },
      );
    const withExt = withOps.filter((p) =>
      (requirements.extensions ?? []).every((id) =>
        p.features.extensions?.some((e) => e.id === id),
      ),
    );
    if (withExt.length === 0)
      throw new AgentropyError(
        'UnsupportedOperation',
        'Required extension not declared',
        { details: { reason: 'extension' } },
      );
    const wanted = requirements.durability;
    const durable = wanted
      ? withExt.filter((p) => rank(p.features.durability) >= rank(wanted))
      : withExt;
    if (durable.length === 0)
      throw new AgentropyError(
        'GuaranteeUnavailable',
        `No route offers ${wanted}`,
        { details: { requested: wanted } },
      );
    // Prefer A2A-style providers for independently addressable agents, direct for co-located ones.
    const preferRemote = Boolean(target.endpoint);
    const chosen = [...durable].sort(
      (a, b) =>
        Number(preferRemote ? a.id === 'direct' : a.id !== 'direct') -
        Number(preferRemote ? b.id === 'direct' : b.id !== 'direct'),
    )[0]!;
    return {
      providerId: chosen.id,
      protocol: chosen.features.protocol,
      protocolVersion: chosen.features.protocolVersion,
      target: { ...target },
    };
  }

  /** Routes are pinned on the task; a later call never re-selects. */
  provider(route: RouteBinding): AgentCommunicationProvider {
    const p = this.providers.get(route.providerId);
    if (
      !p ||
      p.features.protocol !== route.protocol ||
      p.features.protocolVersion !== route.protocolVersion
    ) {
      throw new AgentropyError(
        'NoCompatibleRoute',
        `Pinned route ${route.providerId} is not available`,
        { details: { providerId: route.providerId } },
      );
    }
    return p;
  }
}

/** The co-located runtime side of the direct provider; the TaskService implements it. */
export interface DirectTarget {
  delegate<I>(
    request: DelegationRequest<I>,
    caller: TrustedPrincipal,
  ): Promise<{ taskId: string }>;
  getTask(taskId: string, caller: TrustedPrincipal): Promise<TaskSnapshot>;
  cancel(taskId: string, caller: TrustedPrincipal): Promise<TaskSnapshot>;
  /** Ends after the terminal event, or when `options.signal` aborts. */
  subscribe(
    taskId: string,
    caller: TrustedPrincipal,
    options?: { signal?: AbortSignal },
  ): AsyncIterable<AgentEvent>;
  receive(
    message: AgentMessage,
    caller: TrustedPrincipal,
  ): Promise<{ accepted: boolean }>;
  /**
   * Tasks the caller may see with an opaque cursor, oldest first or, with `newestFirst`, newest first (A2A
   * `ListTasks`, FEAT-034.4, FIX-062). `cursors[i]` resumes right after `tasks[i]`.
   */
  listTasks?(
    query: {
      instanceId?: string;
      cursor?: string;
      limit?: number;
      newestFirst?: boolean;
    },
    caller: TrustedPrincipal,
  ): Promise<{ tasks: TaskSnapshot[]; cursor: string; cursors: string[] }>;
  /** Hands a follow-up message to a task waiting for input (A2A `message.taskId`, FEAT-034.4). */
  continueTask?(
    taskId: string,
    input: unknown,
    messageId: string,
    caller: TrustedPrincipal,
  ): Promise<void>;
}

export class DirectCommunicationProvider implements AgentCommunicationProvider {
  readonly id = 'direct';
  readonly features: CommunicationFeatures;

  constructor(
    private readonly target: DirectTarget,
    /** Declare durable-acceptance only when the target persists before acknowledging. */
    durability: DurabilityLevel,
    private readonly tenantId?: string,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    this.features = {
      operations: ['delegate', 'send', 'getTask', 'cancel', 'subscribe'],
      streaming: true,
      pushNotifications: false,
      durability,
      protocol: 'direct',
      protocolVersion: '1',
    };
  }

  /** Only co-located agents (no endpoint) in this provider's tenant, if bound to one. */
  supports(target: AgentRef, operation: CommunicationOperation): boolean {
    return (
      !target.endpoint &&
      (this.tenantId === undefined || this.tenantId === target.tenantId) &&
      this.features.operations.includes(operation)
    );
  }

  async delegate<I>(
    route: RouteBinding,
    request: DelegationRequest<I>,
    ctx: CallContext,
  ): Promise<RemoteTaskRef> {
    const { taskId } = await this.target.delegate(
      {
        ...request,
        target: {
          ...request.target,
          ...(route.target.instanceId
            ? { instanceId: route.target.instanceId }
            : {}),
        },
      },
      ctx.caller,
    );
    // Direct targets share the local runtime, so the local projection and the remote task carry the same ID.
    return { localTaskId: taskId, route, remoteTaskId: taskId };
  }

  /** The actor of a forwarded message is always the verified caller, never the envelope's claim. */
  async send(
    route: RouteBinding,
    message: AgentMessage,
    ctx: CallContext,
  ): Promise<MessageReceipt> {
    void route;
    validateAgentMessage(message);
    const trusted: AgentMessage = {
      ...message,
      tenantId: ctx.caller.tenantId,
      actor: { principalId: ctx.caller.id, principalType: ctx.caller.type },
    };
    const { accepted } = await this.target.receive(trusted, ctx.caller);
    return { messageId: message.messageId, accepted };
  }

  async getTask(
    ref: RemoteTaskRef,
    ctx: CallContext,
  ): Promise<RemoteTaskState> {
    return this.state(await this.target.getTask(ref.remoteTaskId, ctx.caller));
  }

  async cancel(ref: RemoteTaskRef, ctx: CallContext): Promise<RemoteTaskState> {
    return this.state(await this.target.cancel(ref.remoteTaskId, ctx.caller));
  }

  subscribe(ref: RemoteTaskRef, ctx: CallContext): AsyncIterable<AgentEvent> {
    return this.target.subscribe(
      ref.remoteTaskId,
      ctx.caller,
      ctx.signal ? { signal: ctx.signal } : undefined,
    );
  }

  private state(s: TaskSnapshot): RemoteTaskState {
    return {
      remoteState: s.status,
      normalized: s.status,
      observedAt: this.now(),
    };
  }
}
