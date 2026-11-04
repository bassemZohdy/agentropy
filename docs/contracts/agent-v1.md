# Agentropy Agent Contract v1.0 — Design baseline

**Status:** Architecture contract finalized for initial implementation; not yet implemented or API-stable.  
**Scope:** Core logical Agent, AgentDefinition, AgentInstance, DelegatedTask and Execution. Transport/runtime are independent.

## Decisions

1. **Composition over inheritance.** ConversationalAgent, TaskAgent, MonitoringAgent, CoordinatorAgent and SpecialistAgent are **profile IDs**, not required subclasses. An agent may combine capabilities from several roles.
2. **Four separate identities.** Definition = versioned blueprint; Instance = logical owner-scoped identity; Task = assigned objective; Execution = attempt/continuation. No instance is a worker process.
3. **Agent implementation is a bounded handler.** It receives a context and an invocation, and returns a typed disposition. It does not directly mutate lifecycle tables or own orchestration.
4. **Delegation is async-first.** A service validates authorization/capabilities and returns a TaskHandle after acceptance; completion arrives by status/events/inbox. Handler completion is not automatically user notification.
5. **Always-on = durable responsibility + reactivation.** No permanent worker or continuous LLM call is required.
6. **Security is mandatory platform context.** Tenant, principal and delegated scope come from trusted services, never from arbitrary model output.

## TypeScript contract (normative conceptual shape)

```ts
export type AgentId = string;
export type AgentInstanceId = string;
export type TaskId = string;
export type ExecutionId = string;
export type Version = string;

export type AgentProfileId =
  | "conversational" | "task" | "monitoring"
  | "coordinator" | "specialist" | (string & {});

export interface VersionedRef {
  id: string;
  version: Version;
}

export interface AgentDefinition {
  id: AgentId;
  version: Version;
  displayName: string;
  profile: VersionedRef;
  capabilities: CapabilitySelection[];
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  runtimeRequirements: RuntimeRequirements;
  policyRef: VersionedRef;
}

export interface AgentInstance {
  id: AgentInstanceId;
  definition: VersionedRef;
  tenantId: string;
  ownerId: string;
  state: "available" | "suspended" | "retired";
  revision: number;
}

export interface AgentInvocation<I = unknown> {
  taskId: TaskId;
  executionId: ExecutionId;
  input: I;
  trigger: "direct" | "event" | "schedule" | "delegation" | "resume";
}

export interface AgentContext {
  readonly tenantId: string;
  readonly agentInstanceId: AgentInstanceId;
  readonly taskId: TaskId;
  readonly executionId: ExecutionId;
  readonly principal: TrustedPrincipal;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly signal: AbortSignal;
  readonly capabilities: CapabilityAccess;
  readonly progress: ProgressReporter;
}

export type AgentDisposition<O> =
  | { kind: "completed"; output: O }
  | { kind: "waiting"; wakeup: WakeupRequest; checkpoint: unknown }
  | { kind: "failed"; code: string; retryable: boolean; message: string };

export interface Agent<I = unknown, O = unknown> {
  readonly definition: AgentDefinition;
  handle(invocation: AgentInvocation<I>, context: AgentContext):
    Promise<AgentDisposition<O>>;
}

export interface TaskHandle {
  taskId: TaskId;
  agentInstanceId: AgentInstanceId;
  status: "accepted" | "queued";
  definition: VersionedRef;
}

export interface AgentService {
  delegate<I>(request: DelegationRequest<I>, auth: TrustedPrincipal):
    Promise<TaskHandle>;
  getTask(taskId: TaskId, auth: TrustedPrincipal): Promise<TaskSnapshot>;
  cancel(taskId: TaskId, auth: TrustedPrincipal): Promise<void>;
}

export interface TrustedPrincipal {
  id: string;
  type: "user" | "agent" | "service";
  tenantId: string;
  delegatedAuthorityRef?: string;
}

export interface DelegationRequest<I> {
  target: { definition?: VersionedRef; instanceId?: AgentInstanceId };
  input: I;
  idempotencyKey: string;
  correlationId: string;
  parentTaskId?: TaskId;
  deadline?: string;
}

export interface TaskSnapshot {
  taskId: TaskId;
  status: "created" | "assigned" | "running" | "waiting"
    | "completed" | "failed" | "cancelled";
  revision: number;
}

export interface WakeupRequest {
  kind: "event" | "schedule" | "human-input";
  reference: string;
}

export interface ProgressReporter {
  report(progress: { message: string; percent?: number }): Promise<void>;
}

// Imported from the capability contract, not an Agent subtype:
export type CapabilitySelection = import("./capability-v1").CapabilitySelection;
export type RuntimeRequirements = import("./capability-v1").RuntimeRequirements;
export type CapabilityAccess = import("./capability-v1").CapabilityAccess;
```

The import paths are illustrative documentation references, not compiled modules. Unknown input/output payloads are validated against definition schemas at trusted boundaries.

## Lifecycle authority and invariants

- AgentRuntime/TaskService validates transitions using an explicit transition matrix; an Agent handler cannot mark itself completed in storage.
- `waiting` persists a checkpoint and durable wake-up intent before releasing its worker lease. A checkpoint is not guaranteed to be JSON-serializable until a provider's codec validates it.
- `completed`, `failed`, `cancelled` are terminal task states. A retry policy creates a **new task linked to the prior task**; execution recovery may create another attempt under the *same nonterminal task*. This resolves the previous ambiguous retry language.
- The service deduplicates `(tenantId, callerId, idempotencyKey)` and rejects key reuse with a different request fingerprint.
- Cancellation is requested and may not undo already committed external effects.
- Definition/profile/capability/provider binding versions are snapshotted at task acceptance. Instances may use newer definitions for **future** tasks only.
- Authorization is checked at delegation acceptance and again at sensitive side effects, human approvals and protected reads.

## Agent vs capability boundary

An Agent handler expresses business logic and selects operations through an injected, authorized `CapabilityAccess`. It must not construct providers, query global registries, acquire pool leases or assume a specific LLM/workflow engine. Workflow-backed and model-backed agents satisfy the same handler contract.

## Validation gate

Implementations must pass: distinct identity tests; profile resolution; task acceptance/idempotency; unauthorized delegation; handler result disposition mapping; wait/restart/resume; stale lease fencing; cancellation; version pinning; multi-instance isolation; deterministic workflow-only agent; conversational agent with delegated task.
