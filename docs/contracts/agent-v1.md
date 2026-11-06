# Agentropy Agent Contract v1.0 — revision 11

**Status:** Accepted for M1 implementation (2026-11-05); not API-stable. Implemented types live in `packages/core`; behavior is claimed only where an executable test exists.
**Scope:** Core logical Agent, AgentDefinition, AgentInstance, DelegatedTask and Execution. Transport/runtime are independent.
**Lifecycle states and edges:** [runtime contract](../runtime-contract.md) is authoritative. **Errors:** [Errors v1](errors-v1.md).

## Revision history

| Rev | Date | Change |
|---|---|---|
| 1 | 2026-11-04 | Initial baseline |
| 2 | 2026-11-04 | Design review: instance states aligned with lifecycle; one execution per activation; `WakeupRequest` extended (timer, child tasks, any-of, timeout); idempotent step keys for side effects; `AgentService` gains `getResult`, `provideHumanInput`, idempotency lookup; explicit call layering ([review](../review/2026-11-04-design-review.md)) |
| 3 | 2026-11-04 | Re-review: conversation turn model; handler registry; retry policy; `DelegateInput`; child-task/human-action/event wake semantics with inline payload; `TaskHandle.status` uses task states; instance and human-action operations on `AgentService`; record types; effect-journal commit timing |
| 4–5 | — | Not used (numbering gap preserved; no changes were recorded under these numbers) |
| 6 | 2026-11-05 | Define mandatory/optional AgentDefinition properties, versioned implementation binding, distinct tool/skill selections and execution provider boundary; design only |
| 7 | 2026-11-05 | Readiness closure: `AcceptanceSnapshot`; `Agent.definition` removed (handlers bind by implementation artifact); `HandlerRegistry` keyed by artifact and owned by the `native-ts` provider; `ToolSelection.bindingId`; read-only `AgentContext.skills`; implementation SPI moved to [Agent Implementation v1](agent-implementation-v1.md); tool and skill rules moved to [Tool v1](tool-v1.md) and [Skill v1](skill-v1.md) |
| 8 | 2026-11-05 | Implementation (FEAT-027.1, M1 retrospective): `AgentService` gains `listTasks`, `listInstances`, `drainInstance`, `getHumanAction` and `reauthorize`; `AgentInstance.draining` (not a lifecycle state); event ingress (`publishEvent`) is a trusted adapter operation, not part of `AgentService` |
| 9 | 2026-11-05 | Governance (TASK-026.2, D-03/D-08): an instance accepts delegations only from its owner, principals in `AgentInstance.sharedWith`, agents whose own instance has the same (or a shared) owner, and trusted services — anyone else in the tenant gets `NotFound`; owner-only `shareInstance`; delegators see their own tasks, owners every task on their instance |
| 10 | 2026-11-06 | FEAT-027.9: `DelegationRequest.target.remote = { endpoint, definitionId, version? }` routes through the CommunicationRouter; the caller gets a handle to a local projection (`authority: 'remote'`, durability `none`) refreshed from the authoritative remote task, visible like a local child; `child-tasks` wake-ups include remote children; grants never cross the boundary |
| 11 | 2026-11-06 | FEAT-028.3 ([ADR-0029](../adr/0029-upgrades-and-version-migration.md)): `AgentService.upgradeInstance` (audited, future tasks only, rollback = upgrade to an earlier version) and `versionsInUse`; `AgentInstance.previousDefinition`; `Agent.checkpointCodec` with `IncompatibleVersion` on unreadable checkpoints |

## Decisions

1. **Composition over inheritance.** Conversational, Task, Monitoring, Coordinator and Specialist are **profile IDs**, not subclasses.
2. **Four separate identities.** Definition = versioned blueprint; Instance = logical owner-scoped identity; Task = assigned objective; Execution = one activation of the handler for a task. No instance is a worker process.
3. **Agent execution is implementation-neutral.** A native handler receives a context and invocation and returns a typed disposition; other implementations use an explicit adapter with equivalent lifecycle semantics. No adapter writes authoritative task state or bypasses orchestration.
4. **Delegation is async-first.** Acceptance returns a `TaskHandle`; completion arrives by status/events/inbox. Handler completion is not user notification.
5. **Always-on = durable responsibility + reactivation.** A long-lived responsibility is a non-terminal task that cycles `waiting ⇄ running`; each wake-up is a new Execution ([ADR-0018](../adr/0018-execution-per-activation.md)).
6. **Security is mandatory platform context.** Tenant, principal and delegated scope come from trusted services, never from model output.

## Call layering

Handlers never call the TaskService, router or providers directly. Every outbound action goes through the injected `CapabilityAccess`:

```mermaid
flowchart LR
  H[Agent handler] -->|capabilities.invoke| CA[CapabilityAccess<br/>authorized bindings only]
  CA --> DP[delegation capability<br/>built-in provider]
  CA --> OP[other capability providers<br/>tools, model, memory, workflow]
  DP --> TS[TaskService / AgentService<br/>authoritative for local tasks]
  TS -->|local target| RT[AgentRuntime + Pool]
  TS -->|remote target| CR[CommunicationRouter]
  CR --> A2A[A2A provider] --> REM[Remote agent runtime]
  IN[Inbound A2A / API gateway] -->|verified principal| TS
```

`AgentService` is the public, principal-taking API used by applications, the conversational surface and inbound adapters. `AgentCommunication` ([Communication v1](communication-v1.md)) is an **outbound SPI used only by the TaskService** for remote targets.

## TypeScript contract (normative conceptual shape)

```ts
export type AgentId = string;
export type AgentInstanceId = string;
export type TaskId = string;
export type ExecutionId = string;
export type Version = string;

export type AgentProfileId =
  | "conversational" | "task" | "monitoring"
  | "coordinator" | "specialist" | "generic" | (string & {});

export interface VersionedRef { id: string; version: Version; }

/** Identifies an implementation adapter and its immutable artifact/config revision. */
export interface AgentImplementationRef {
  providerId: string;              // e.g. native-ts, langgraph-js, workflow, remote-proxy
  providerVersion: Version;
  artifact: VersionedRef;          // trusted code/graph/workflow/remote binding; never inline executable content
}

export interface SkillSelection {
  id: string;                      // trusted registry identity, not an arbitrary filesystem path
  versionRange: string;            // resolve and pin exact version at task acceptance
  required?: boolean;              // default true
}

export interface ToolSelection {
  id: string;                      // canonical logical ToolRegistry identity (not a URL)
  versionRange: string;            // resolve and pin exact version and permitted binding
  required?: boolean;              // default true
  bindingId?: string;              // explicit physical binding; otherwise the tool's default binding
}

export interface AgentDefinition {
  id: AgentId;
  version: Version;                 // immutable once registered
  displayName: string;
  profile: VersionedRef;           // use a generic/custom profile if no specialized behavior is required
  implementation: AgentImplementationRef;
  inputSchema: JsonSchema;         // a permissive JSON Schema is valid for unstructured inputs
  runtimeRequirements: RuntimeRequirements; // may contain an empty guarantees array
  policyRef: VersionedRef;         // trusted, non-bypassable policy
  description?: string;
  capabilities?: CapabilitySelection[]; // additions/removals relative to profile; absent = none added
  skills?: SkillSelection[];       // Agent Skills standard, not an authorization grant
  tools?: ToolSelection[];         // logical tool allow-list requests, not permissions
  outputSchema?: JsonSchema;
  modelRef?: VersionedRef;         // optional reasoning/model config; never required for deterministic agents
  memoryRef?: VersionedRef;        // optional memory configuration
  communicationRef?: VersionedRef; // optional preference; does NOT bypass TaskService/CommunicationRouter
  retryPolicy?: { maxAttempts: number; backoff: { initialMs: number; maxMs: number; multiplier: number } };
}

export interface AgentInstance {
  id: AgentInstanceId;
  definition: VersionedRef;         // default for FUTURE tasks
  tenantId: string;
  ownerId: string;                  // principal that owns the logical agent
  state: "available" | "suspended" | "retired";
  revision: number;
  draining?: boolean;               // set by drainInstance; not a lifecycle state
  sharedWith?: string[];            // principals allowed to delegate (owner-managed, same tenant)
  previousDefinition?: VersionedRef; // version before the last upgradeInstance (rev 11)
}

export interface AgentInvocation<I = unknown> {
  taskId: TaskId;
  executionId: ExecutionId;
  activation: number;               // 1 for first run, +1 per wake-up (not per retry)
  attempt: number;                  // 1.., +1 per retry within this activation
  input: I;                         // original task input
  trigger: "delegation" | "resume" | "retry";
  checkpoint?: unknown;             // last committed checkpoint, absent on first activation
  wakeReason?: WakeReason;          // which condition fired, on resume
}

export interface AgentContext {
  readonly tenantId: string;
  readonly agentInstanceId: AgentInstanceId;
  readonly taskId: TaskId;
  readonly executionId: ExecutionId;
  readonly principal: TrustedPrincipal;   // the agent instance acting under delegatedAuthority
  readonly correlationId: string;
  readonly causationId?: string;
  readonly deadline?: string;
  readonly signal: AbortSignal;           // fired on cancel or lease loss
  readonly capabilities: CapabilityAccess;
  readonly progress: ProgressReporter;
  readonly skills: SkillAccess;           // read-only, pinned skills only; empty when none selected (Skill v1)
}

export type AgentDisposition<O> =
  | { kind: "completed"; output: O }
  | { kind: "waiting"; wakeup: WakeupRequest; checkpoint: unknown }
  | { kind: "failed"; code: string; retryable: boolean; message: string };

export interface Agent<I = unknown, O = unknown> {
  handle(invocation: AgentInvocation<I>, context: AgentContext):
    Promise<AgentDisposition<O>>;
  // rev 11: checkpoints are stored with this version (default 1); older ones go through upgrade(),
  // a missing/throwing upgrade or a newer checkpoint fails the activation with IncompatibleVersion
  checkpointCodec?: { version: number; upgrade?(checkpoint: unknown, fromVersion: number): unknown };
}

// --- Wake-ups --------------------------------------------------------------

export type WakeupCondition =
  | { kind: "timer"; at: string }                         // one-shot ISO instant
  | { kind: "schedule"; cron: string; timezone: string }  // next occurrence only; re-register each activation
  | { kind: "event"; subscription: string; filter?: unknown }
  | { kind: "human-action"; requestId: string }
  | { kind: "child-tasks"; taskIds: TaskId[]; mode: "all" | "any" };  // over TERMINAL states (completed, failed, cancelled)

export interface WakeupRequest {
  anyOf: WakeupCondition[];          // first condition to fire wins; others are revoked
  timeoutAt?: string;
  onTimeout?: "resume" | "fail";     // default "resume" with wakeReason.kind = "timeout"
}

export type WakeReason =
  | { kind: "timer" | "schedule"; firedAt: string }
  | { kind: "event"; subscription: string; eventId: string; payload: unknown }   // oldest pending mailbox event
  | { kind: "human-action"; requestId: string; outcome: "resolved" | "expired" | "revoked"; input?: unknown }
  | { kind: "child-tasks"; children: { taskId: TaskId; status: "completed" | "failed" | "cancelled";
        output?: unknown; outcome?: { code: string; message: string } }[] }
  | { kind: "timeout" };

// --- Public service --------------------------------------------------------

export interface TaskHandle {
  taskId: TaskId;
  agentInstanceId: AgentInstanceId;
  status: "created" | "assigned";   // task state at acceptance (rev 2 used non-state values)
  definition: VersionedRef;
  durability: "none" | "durable-acceptance" | "durable-execution";
}

export interface AgentService {
  // Tasks
  delegate<I>(request: DelegationRequest<I>, caller: TrustedPrincipal): Promise<TaskHandle>;
  getTask(taskId: TaskId, caller: TrustedPrincipal): Promise<TaskSnapshot>;
  getTaskByIdempotencyKey(key: string, caller: TrustedPrincipal): Promise<TaskSnapshot>;
  getResult<O>(taskId: TaskId, caller: TrustedPrincipal): Promise<O>;   // NotReady / TaskFailed / TaskCancelled
  listTasks(query: { instanceId?: AgentInstanceId; status?: TaskSnapshot["status"][]; cursor?: string; limit?: number }, caller: TrustedPrincipal): Promise<{ tasks: TaskSnapshot[]; cursor: string }>; // own tasks only; a trusted service sees its tenant
  reauthorize(taskId: TaskId, caller: TrustedPrincipal): Promise<void>; // ADR-0024: re-establish authority for a gated task; never dispatches by itself
  cancel(taskId: TaskId, caller: TrustedPrincipal, reason?: string): Promise<TaskSnapshot>;
  subscribe(taskId: TaskId, caller: TrustedPrincipal, from?: { revision: number; sequence: number }): AsyncIterable<TaskEvent>;
  // Conversation (see "Conversation turn model")
  submitTurn(turn: ConversationTurn, caller: TrustedPrincipal): Promise<TaskHandle>;
  // Instances
  createInstance(req: { definition: VersionedRef; ownerId: string; idempotencyKey: string }, caller: TrustedPrincipal): Promise<AgentInstance>;
  suspendInstance(instanceId: AgentInstanceId, caller: TrustedPrincipal): Promise<AgentInstance>;
  resumeInstance(instanceId: AgentInstanceId, caller: TrustedPrincipal): Promise<AgentInstance>;
  retireInstance(instanceId: AgentInstanceId, caller: TrustedPrincipal, opts?: { force?: boolean }): Promise<AgentInstance>;
  drainInstance(instanceId: AgentInstanceId, caller: TrustedPrincipal): Promise<AgentInstance>; // no new tasks; retires when the last task ends
  upgradeInstance(instanceId: AgentInstanceId, change: { version: string; expectedRevision: number }, caller: TrustedPrincipal): Promise<AgentInstance>; // rev 11; future tasks only; audited
  versionsInUse(definitionId: string, caller: TrustedPrincipal): Promise<{ version: string; instances: number; activeTasks: number }[]>; // rev 11; trusted services
  shareInstance(instanceId: AgentInstanceId, principalIds: string[], caller: TrustedPrincipal): Promise<AgentInstance>; // owner only; replaces the share list
  listInstances(caller: TrustedPrincipal, ownerId?: string): Promise<AgentInstance[]>; // another owner's only for trusted services
  // Human actions (types in human-actions.md)
  claimHumanAction(requestId: string, caller: TrustedPrincipal): Promise<HumanActionRequest>;
  releaseHumanAction(requestId: string, caller: TrustedPrincipal): Promise<HumanActionRequest>;
  getHumanAction(requestId: string, caller: TrustedPrincipal): Promise<HumanActionRequest>;
  provideHumanInput(decision: HumanDecision, caller: TrustedPrincipal): Promise<void>;
  // Inbox (projection; types in human-actions.md)
  listInbox(query: { cursor?: string; limit?: number }, caller: TrustedPrincipal): Promise<{ entries: InboxEntry[]; cursor: string }>;
  markInbox(entryId: string, marker: "presented" | "read" | "acknowledged", caller: TrustedPrincipal, presentedRevision?: number): Promise<void>;
}

export interface ConversationTurn {
  instanceId: AgentInstanceId;      // the user's conversational agent instance
  sessionId: string;
  text: string;
  idempotencyKey: string;
  correlationId?: string;           // generated if absent
}

/** What a handler passes to delegation.delegate; the runtime fills the rest. */
export interface DelegateInput<I = unknown> {
  target: DelegationRequest<I>["target"];
  input: I;
  deadline?: string;
  budget?: DelegationRequest<I>["budget"];
}
// Runtime fills: idempotencyKey = derived from stepKey; correlationId = context.correlationId;
// parentTaskId = context.taskId; caller = the acting instance under its delegated authority.

export interface TrustedPrincipal {
  id: string;
  type: "user" | "agent" | "service";
  tenantId: string;
  delegatedAuthorityRef?: string;    // grant chain; narrowed, never widened, on each delegation hop
}

export interface DelegationRequest<I> {
  target: { definition?: VersionedRef; instanceId?: AgentInstanceId };
  input: I;
  idempotencyKey: string;
  correlationId: string;
  parentTaskId?: TaskId;
  deadline?: string;
  budget?: { maxCostUnits?: number; maxActivations?: number };
}

export interface TaskSnapshot {
  taskId: TaskId;
  status: "created" | "assigned" | "running" | "waiting"
    | "completed" | "failed" | "cancelled";
  revision: number;
  agentInstanceId?: AgentInstanceId;
  parentTaskId?: TaskId;
  retryOf?: TaskId;
  cancelRequestedAt?: string;
  waitingOn?: WakeupRequest;
  outcome?: { code: string; message: string };   // for failed/cancelled
  authority: "local" | "remote";                  // remote = projection of an A2A task
}

export interface ProgressReporter {
  report(progress: { message: string; percent?: number; stepKey?: string }): Promise<void>;
}

// --- Records (persisted by the platform; read via getTask / internal APIs) ---

export interface ExecutionRecord {
  executionId: ExecutionId;
  taskId: TaskId;
  activation: number;
  attempt: number;
  trigger: AgentInvocation["trigger"];
  state: "queued" | "leased" | "running" | "succeeded" | "yielded" | "failed" | "aborted" | "lost";
  leaseEpoch?: number;
  startedAt?: string;
  endedAt?: string;
}

export interface WakeupRegistration {
  id: string;
  taskId: TaskId;
  conditions: WakeupCondition[];
  timeoutAt?: string;
  onTimeout: "resume" | "fail";
  status: "armed" | "fired" | "revoked";
  revision: number;
}

/** Native TypeScript artifact store used by the `native-ts` implementation provider (Agent Implementation v1). */
export interface HandlerRegistry {
  register(artifact: VersionedRef, handler: Agent): void;   // re-registering a different handler → InvalidConfiguration
  unregister(artifact: VersionedRef): void;      // in-flight tasks pinned to it then fail IncompatibleVersion
  get(artifact: VersionedRef): Agent | undefined;
}

/** Immutable, redacted pins recorded at task acceptance (T1). */
export interface AcceptanceSnapshot extends EffectiveCapabilitySnapshot {
  definition: VersionedRef;
  profile: VersionedRef;
  implementation: ImplementationBinding;          // Agent Implementation v1
  durability: "none" | "durable-acceptance" | "durable-execution";
  tools: ToolPin[];                               // Tool v1
  skills: SkillPin[];                             // Skill v1
  omitted: { kind: "capability" | "tool" | "skill"; id: string; code: string }[];
}

// Defined elsewhere:
//   CapabilitySelection, RuntimeRequirements, CapabilityAccess, EffectiveCapabilitySnapshot -> capability-v1.md
//   ImplementationBinding -> agent-implementation-v1.md; ToolPin -> tool-v1.md; SkillPin, SkillAccess -> skill-v1.md
//   HumanDecision, HumanActionRequest, InboxEntry -> human-actions.md; TaskEvent -> messaging-contract.md
//   JsonSchema = JSON Schema 2020-12 document
```

Import paths are documentation references, not compiled modules.

## Agent definition requirements and implementation boundary (revision 6)

**Mandatory fields:** `id`, immutable `version`, `displayName`, `profile`, `implementation`, `inputSchema`, `runtimeRequirements` (empty guarantees permitted), and `policyRef`. Core identity, trusted principal, audit enforcement and policy evaluation are platform obligations even when no optional selections exist.

**Optional fields:** `description`, `capabilities`, `skills`, `tools`, `outputSchema`, `modelRef`, `memoryRef`, `communicationRef`, `retryPolicy`. An omitted selection means no additional selection; mandatory profile requirements still apply. Do not require an LLM, tools, skills, memory or outbound agent communication for a deterministic implementation. A custom `generic` profile may have no behavior capabilities, but cannot bypass universal platform controls.

| Concept | Role | Authority |
|---|---|---|
| Profile | Required/default capability/guarantee selections | Cannot downgrade required capabilities or guarantees |
| Capability | Platform behavior or verified guarantee | `CapabilityAccess` is the only handler effect surface |
| Skill | Agent Skills-standard instructions/resources (optional) | Never confers tool/script execution permission |
| Tool | Canonical callable operation (optional) | `ToolSelection` requests visibility; PEP/PDP decides invocation |
| Implementation | Native TS, LangGraph.js, workflow adapter, or remote proxy | Implementation provider supplies compatible lifecycle mapping |
| Runtime | Owns Task/Execution state, leasing, persistence and enforcement | Verifies guarantees; cannot infer them from an adapter name |

**Implementation SPI:** normative in [Agent Implementation v1](agent-implementation-v1.md). A native TypeScript handler is one adapter (`native-ts`, backed by `HandlerRegistry`); LangGraph.js, workflow engines and remote proxies are optional adapters. A remote A2A agent is normally delegated to through `TaskService → CommunicationRouter`; remote-authority proxies are rejected in M1. Provider and artifact revision are pinned at task acceptance; no silent provider swap mid-task.

**Resolution order** (implemented as one pure function over registries; first failure wins): validate immutable definition/profile/policy and schema → resolve implementation and its declared features → merge profile-required/default and optional capability selections per [Capability v1](capability-v1.md) → resolve Skill and Tool references to trusted exact versions/bindings → validate declared Skill dependencies against available capabilities/tools *without granting them* → intersect tool visibility and all invocations with current tenant/user/delegated policy → validate runtime guarantees and pin redacted effective bindings at acceptance. Reject missing required dependencies, incompatible versions, unsupported features and insufficient guarantees explicitly; optional tool/skill failures are omitted and recorded in `AcceptanceSnapshot.omitted`. Skill content or remote tool manifests are untrusted and cannot modify policy. Error mapping is listed in [Errors v1](errors-v1.md#contract-error-mapping-revision-2).

### Acceptance snapshot (revision 7)

`AcceptanceSnapshot` is the single record pinned on a task at T1. It contains no credentials and no Skill/tool payload content; it supersedes the earlier separate lists of pinned items in the [runtime contract](../runtime-contract.md#version-pinning-and-upgrade). Each activation runs against it; authority is re-evaluated at every protected operation regardless of the snapshot.

**Conformance gate:** Native deterministic and second implementation adapter must pass the same logical task lifecycle tests; custom/generic profile must run with no optional model/tool/skill; required profile guarantees cannot be removed; Skills must not auto-grant tool authority; tool route changes must preserve policy, effects and pinning; remote agent acceptance/status/cancel must remain mapped through TaskService. Implementation SDKs, provider feature taxonomy and artifact distribution are deferred design details, not claims of runtime support.

## Idempotent side effects

A crashed or lost execution is re-run (T6), so handlers must be **replay-safe**:

- Every capability operation is classified `read`, `internal` or `external` ([Capability v1](capability-v1.md#contract-types-normative-conceptual-shape)). `external` and `delegate` operations **require** a `stepKey` in `capabilities.invoke(..., { stepKey })`.
- The runtime derives the effective idempotency key as `hash(tenantId, taskId, capabilityId, operation, stepKey)`. The same step in a later activation or attempt therefore reuses the same key.
- **Effect journal timing:** the journal entry is committed **at invocation time, independent of the disposition transaction** (which may never commit if the worker crashes). For platform-internal effects (inbox notification, child-task creation, human-action creation) the effect and its journal entry are written in **one** transaction, so they are exactly-once. For external effects the runtime checks the journal first, passes the key to the provider, and records the result when the call returns; a crash between provider success and journal write is covered only by the provider honoring the key — a provider that cannot must declare so and is treated as at-least-once.
- `stepKey` must be deterministic from task input + checkpoint (e.g. `"notify:threshold-crossed:2026-11-04"`), never a random value or timestamp of the current run.
- Child delegations use the same mechanism, so a re-run coordinator does not spawn duplicate children. For agent callers the deduplication key below is the derived key.

## Lifecycle authority and invariants

- Transitions are applied only by the TaskService/AgentRuntime using the [transition tables](../runtime-contract.md).
- `waiting` commits checkpoint + wake-up registration before releasing the lease.
- `completed`, `failed`, `cancelled` are terminal. Retrying a terminal task creates a **new task linked by `retryOf`**; execution recovery creates a new Execution under the same non-terminal task.
- Delegation is deduplicated on `(tenantId, caller.id, idempotencyKey)`; reuse with a different request fingerprint fails `IdempotencyConflict`.
- Cancellation is a request; it never undoes committed external effects.
- Version snapshot taken at acceptance; instances adopt newer definitions for future tasks only.
- Authorization is checked at acceptance and again at sensitive side effects, human decisions and protected reads.

## Conversation turn model

Each user message is one **turn task** delegated to the user's conversational instance by `AgentService.submitTurn` (durability `durable-acceptance`). The turn handler:

1. calls `conversation.briefing` first — returns a bounded, authorized inbox snapshot of entries not yet presented at their current revision, and marks them `presented`;
2. decides, optionally via `reasoning`, whether to answer directly or call `delegation.delegate` (it does **not** wait for the child; the child reports through the inbox);
3. completes with `{ reply: string }`, which the client reads via `getResult`/`subscribe`.

Session continuity lives in `session-context` keyed by `sessionId`, not in a long-running task. A conversational agent can therefore be fully rule-based (no `reasoning` binding) or model-backed with the same contract.

## Agent vs capability boundary

A handler expresses business logic and acts only through the injected `CapabilityAccess`. It must not construct providers, read global registries, acquire leases, generate its own idempotency keys for effects, or assume a specific LLM/workflow engine. Workflow-backed and model-backed agents satisfy the same contract.

## Validation gate


Distinct identity tests; profile resolution; acceptance + idempotency + unknown acceptance; unauthorized delegation; disposition mapping; wait → restart → resume with checkpoint; child-task wait (`all`/`any`); timeout wake-up; stale lease fencing; cancellation with non-cooperative handler; step-key replay without duplicate effect; version pinning; multi-instance isolation; deterministic workflow-only agent; conversational turn that delegates and a later turn whose briefing reports the result. Each maps to an acceptance check in [POC scope](../poc-scope.md) or a later milestone.

## Agent Skills selection (revision 6)

`AgentDefinition.skills?: SkillSelection[]` references standard [Agent Skills](https://agentskills.io/specification) artifacts independently of Capabilities and Tools. `SkillRegistry`, `SkillLoader` and `SkillAccess` are normative in [Skill v1](skill-v1.md); script execution is unsupported in v1. See [ADR-0026](../adr/0026-protocol-agnostic-tool-integration.md).
