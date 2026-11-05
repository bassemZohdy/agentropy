/** Agent v1 revision 7 (docs/contracts/agent-v1.md). Types only; no I/O. */
import type {
  CapabilityAccess,
  CapabilitySelection,
  EffectiveCapabilitySnapshot,
  RuntimeRequirements,
} from './capability.js';
import type { ImplementationBinding } from './implementation.js';
import type { SkillAccess, SkillPin } from './skill.js';
import type { ToolPin } from './tool.js';

export type AgentId = string;
export type AgentInstanceId = string;
export type TaskId = string;
export type ExecutionId = string;
export type Version = string;
/** JSON Schema 2020-12 document. */
export type JsonSchema = Record<string, unknown> | boolean;

export type AgentProfileId =
  | 'conversational'
  | 'task'
  | 'monitoring'
  | 'coordinator'
  | 'specialist'
  | 'generic'
  | (string & {});
export type DurabilityLevel =
  'none' | 'durable-acceptance' | 'durable-execution';

export interface VersionedRef {
  id: string;
  version: Version;
}

export interface AgentImplementationRef {
  providerId: string;
  providerVersion: Version;
  artifact: VersionedRef;
}

export interface SkillSelection {
  id: string;
  versionRange: string;
  required?: boolean; // default true
}

export interface ToolSelection {
  id: string;
  versionRange: string;
  required?: boolean; // default true
  bindingId?: string;
}

export interface RetryPolicy {
  maxAttempts: number;
  backoff: { initialMs: number; maxMs: number; multiplier: number };
}

export interface AgentDefinition {
  id: AgentId;
  version: Version;
  displayName: string;
  profile: VersionedRef;
  implementation: AgentImplementationRef;
  inputSchema: JsonSchema;
  runtimeRequirements: RuntimeRequirements;
  policyRef: VersionedRef;
  description?: string;
  capabilities?: CapabilitySelection[];
  skills?: SkillSelection[];
  tools?: ToolSelection[];
  outputSchema?: JsonSchema;
  modelRef?: VersionedRef;
  memoryRef?: VersionedRef;
  communicationRef?: VersionedRef;
  retryPolicy?: RetryPolicy;
}

export interface AgentInstance {
  id: AgentInstanceId;
  definition: VersionedRef;
  tenantId: string;
  ownerId: string;
  state: 'available' | 'suspended' | 'retired';
  revision: number;
  /** Set by drain: no new tasks are accepted; the instance retires when its last task ends (not a lifecycle state). */
  draining?: boolean;
}

export interface TrustedPrincipal {
  id: string;
  type: 'user' | 'agent' | 'service';
  tenantId: string;
  delegatedAuthorityRef?: string;
}

export type WakeupCondition =
  | { kind: 'timer'; at: string }
  | { kind: 'schedule'; cron: string; timezone: string }
  | { kind: 'event'; subscription: string; filter?: unknown }
  | { kind: 'human-action'; requestId: string }
  | { kind: 'child-tasks'; taskIds: TaskId[]; mode: 'all' | 'any' };

export interface WakeupRequest {
  anyOf: WakeupCondition[];
  timeoutAt?: string;
  onTimeout?: 'resume' | 'fail';
}

export type WakeReason =
  | { kind: 'timer' | 'schedule'; firedAt: string }
  | { kind: 'event'; subscription: string; eventId: string; payload: unknown }
  | {
      kind: 'human-action';
      requestId: string;
      outcome: 'resolved' | 'expired' | 'revoked';
      input?: unknown;
    }
  | {
      kind: 'child-tasks';
      children: {
        taskId: TaskId;
        status: 'completed' | 'failed' | 'cancelled';
        output?: unknown;
        outcome?: { code: string; message: string };
      }[];
    }
  | { kind: 'timeout' };

export interface AgentInvocation<I = unknown> {
  taskId: TaskId;
  executionId: ExecutionId;
  activation: number;
  attempt: number;
  input: I;
  trigger: 'delegation' | 'resume' | 'retry';
  checkpoint?: unknown;
  wakeReason?: WakeReason;
}

export interface ProgressReporter {
  report(progress: {
    message: string;
    percent?: number;
    stepKey?: string;
  }): Promise<void>;
}

export interface AgentContext {
  readonly tenantId: string;
  readonly agentInstanceId: AgentInstanceId;
  readonly taskId: TaskId;
  readonly executionId: ExecutionId;
  readonly principal: TrustedPrincipal;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly deadline?: string;
  readonly signal: AbortSignal;
  readonly capabilities: CapabilityAccess;
  readonly progress: ProgressReporter;
  readonly skills: SkillAccess;
}

export type AgentDisposition<O> =
  | { kind: 'completed'; output: O }
  | { kind: 'waiting'; wakeup: WakeupRequest; checkpoint: unknown }
  | { kind: 'failed'; code: string; retryable: boolean; message: string };

export interface Agent<I = unknown, O = unknown> {
  handle(
    invocation: AgentInvocation<I>,
    context: AgentContext,
  ): Promise<AgentDisposition<O>>;
}

export interface HandlerRegistry {
  register(artifact: VersionedRef, handler: Agent): void;
  unregister(artifact: VersionedRef): void;
  get(artifact: VersionedRef): Agent | undefined;
}

export interface DelegationRequest<I = unknown> {
  target: { definition?: VersionedRef; instanceId?: AgentInstanceId };
  input: I;
  idempotencyKey: string;
  correlationId: string;
  parentTaskId?: TaskId;
  deadline?: string;
  budget?: { maxCostUnits?: number; maxActivations?: number };
}

export interface DelegateInput<I = unknown> {
  target: DelegationRequest<I>['target'];
  input: I;
  deadline?: string;
  budget?: DelegationRequest<I>['budget'];
}

export interface TaskHandle {
  taskId: TaskId;
  agentInstanceId: AgentInstanceId;
  status: 'created' | 'assigned';
  definition: VersionedRef;
  durability: DurabilityLevel;
}

export interface TaskSnapshot {
  taskId: TaskId;
  status:
    | 'created'
    | 'assigned'
    | 'running'
    | 'waiting'
    | 'completed'
    | 'failed'
    | 'cancelled';
  revision: number;
  agentInstanceId?: AgentInstanceId;
  parentTaskId?: TaskId;
  retryOf?: TaskId;
  cancelRequestedAt?: string;
  waitingOn?: WakeupRequest;
  outcome?: { code: string; message: string };
  authority: 'local' | 'remote';
}

export interface ExecutionRecord {
  executionId: ExecutionId;
  taskId: TaskId;
  activation: number;
  attempt: number;
  trigger: AgentInvocation['trigger'];
  state:
    | 'queued'
    | 'leased'
    | 'running'
    | 'succeeded'
    | 'yielded'
    | 'failed'
    | 'aborted'
    | 'lost';
  leaseEpoch?: number;
  startedAt?: string;
  endedAt?: string;
}

export interface WakeupRegistration {
  id: string;
  taskId: TaskId;
  conditions: WakeupCondition[];
  timeoutAt?: string;
  onTimeout: 'resume' | 'fail';
  status: 'armed' | 'fired' | 'revoked';
  revision: number;
}

export interface OmittedSelection {
  kind: 'capability' | 'tool' | 'skill';
  id: string;
  code: string;
}

/** Immutable, redacted pins recorded at task acceptance (T1). */
export interface AcceptanceSnapshot extends EffectiveCapabilitySnapshot {
  definition: VersionedRef;
  profile: VersionedRef;
  implementation: ImplementationBinding;
  durability: DurabilityLevel;
  tools: ToolPin[];
  skills: SkillPin[];
  omitted: OmittedSelection[];
}
