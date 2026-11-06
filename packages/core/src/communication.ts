/** Communication v1 revision 4 types (docs/contracts/communication-v1.md). */
import type {
  DelegationRequest,
  DurabilityLevel,
  TaskSnapshot,
  TrustedPrincipal,
} from './agent.js';

export interface AgentRef {
  definitionId: string;
  instanceId?: string;
  version?: string;
  tenantId: string;
  endpoint?: string;
}

export interface CallContext {
  caller: TrustedPrincipal;
  correlationId: string;
  causationId?: string;
  deadline?: string;
  signal?: AbortSignal;
}

export interface RouteBinding {
  providerId: string;
  protocol: string;
  protocolVersion: string;
  target: AgentRef;
}

export interface RemoteTaskRef {
  localTaskId: string;
  route: RouteBinding;
  remoteTaskId: string;
}

export type CommunicationOperation =
  'delegate' | 'send' | 'getTask' | 'cancel' | 'subscribe';

export interface CommunicationFeatures {
  operations: readonly CommunicationOperation[];
  streaming: boolean;
  pushNotifications: boolean;
  durability: DurabilityLevel | 'provider-dependent';
  protocol: string;
  protocolVersion: string;
  extensions?: readonly { id: string; version: string }[];
}

export interface RouteRequirements {
  operations?: readonly CommunicationOperation[];
  durability?: DurabilityLevel;
  extensions?: readonly string[];
}

export interface AgentMessage<T = unknown> {
  schemaVersion: number;
  kind: 'command' | 'query' | 'event';
  name: string;
  messageId: string;
  correlationId: string;
  causationId?: string;
  idempotencyKey?: string;
  tenantId: string;
  agentDefinitionId?: string;
  agentDefinitionVersion?: string;
  agentInstanceId?: string;
  taskId?: string;
  parentTaskId?: string;
  executionId?: string;
  actor: {
    principalId: string;
    principalType: 'user' | 'service' | 'agent';
    delegatedBy?: string;
  };
  createdAt: string;
  payload: T;
}

export interface MessageReceipt {
  messageId: string;
  accepted: boolean;
}

export interface AgentEvent {
  eventId: string;
  taskId: string;
  type: string;
  revision?: number;
  payload: unknown;
}

export interface RemoteTaskState {
  remoteState: string;
  normalized: TaskSnapshot['status'] | 'unknown';
  observedAt: string;
  /** Result reported by the remote side once completed (data, never instructions). */
  output?: unknown;
}

export interface AgentCommunicationProvider {
  readonly id: string;
  readonly features: CommunicationFeatures;
  supports(target: AgentRef, operation: CommunicationOperation): boolean;
  delegate<I>(
    route: RouteBinding,
    request: DelegationRequest<I>,
    ctx: CallContext,
  ): Promise<RemoteTaskRef>;
  send(
    route: RouteBinding,
    message: AgentMessage,
    ctx: CallContext,
  ): Promise<MessageReceipt>;
  getTask(ref: RemoteTaskRef, ctx: CallContext): Promise<RemoteTaskState>;
  cancel(ref: RemoteTaskRef, ctx: CallContext): Promise<RemoteTaskState>;
  subscribe(ref: RemoteTaskRef, ctx: CallContext): AsyncIterable<AgentEvent>;
}

export interface CommunicationRouter {
  register(provider: AgentCommunicationProvider): void;
  selectRoute(
    target: AgentRef,
    operation: CommunicationOperation,
    ctx: CallContext,
    requirements?: RouteRequirements,
  ): Promise<RouteBinding>;
  provider(route: RouteBinding): AgentCommunicationProvider;
}
