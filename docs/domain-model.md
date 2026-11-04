# Agent domain model and lifecycle

## Entities

| Entity | Key fields | Purpose |
|---|---|---|
| AgentDefinition | definitionId, version, profileId, capability specs, runtime requirements, policy | Immutable/versioned reusable specification |
| AgentProfile | profileId, version, required, defaults, optional, constraints | Reusable configuration template |
| AgentInstance | instanceId, definitionRef, owner, tenant, effective capabilities, lifecycle | Logical identity independent of process |
| DelegatedTask | taskId, parentTaskId, instanceId, principal, objective, state, deadlines, limits | Bounded obligation and coordination unit |
| Execution | executionId, taskId, attempt, state, checkpointRef, timestamps, leaseId | Running or suspended attempt |
| CapabilityBinding | capabilityId, contractVersion, providerId, config, policy | Validated implementation selection |
| InboxEntry | entryId, userId, taskId, severity, category, payloadRef, status | Durable notification/approval/result |
| AgentLease | leaseId, executionId, provider, expiry | Short-lived execution capacity grant |

IDs are opaque and globally unambiguous within the configured tenancy namespace. Include actor identity, delegated authority, trace context, and idempotency keys in all state-changing envelopes.

## Representative TypeScript contracts (illustrative; not implemented)

```ts
type AgentRole = 'conversational' | 'task' | 'monitoring' | 'coordinator' | 'specialist';
type TaskState =
  | 'created' | 'assigned' | 'running' | 'waiting'
  | 'completed' | 'failed' | 'cancelled';

interface CapabilitySpec {
  id: string;
  version: string;
  config?: Record<string, unknown>;
}

interface AgentProfile {
  id: string;
  version: string;
  required: CapabilitySpec[];
  defaults: CapabilitySpec[];
  optional: string[];
}

interface AgentDefinition {
  id: string;
  version: string;
  role: AgentRole;
  profile: { id: string; version: string };
  capabilities: CapabilitySpec[];
  runtime: { requiredGuarantees: string[] };
}

interface AgentContext {
  executionId: string;
  taskId: string;
  tenantId: string;
  principalId: string;
  correlationId: string;
  idempotencyKey: string;
  signal: AbortSignal;
}

interface Agent<I = unknown, O = unknown> {
  readonly definition: AgentDefinition;
  execute(input: I, context: AgentContext): Promise<O>;
}
```

Capability contracts and the actual execution state envelope will evolve before coding begins. Implementations must not confuse optional cancellation requests with guaranteed external side-effect cancellation.

## Extended contracts and version pinning

See [task lifecycle and operation guards](runtime-contract.md), [message envelope](messaging-contract.md) and [human actions](human-actions.md). A DelegatedTask should retain immutable accepted-time snapshots: agent definition/profile revision, capability contract versions, provider/build binding, input schema version and delegated authority metadata. A HumanActionRequest is separately identifiable by stable request ID, input kind/schema, assignee(s), deadline, state and revision. InboxEntry tracks read/presented/resolved independently from authoritative task state.

A task startup is **async-first**, reporting an accepted reference rather than an implied final result. All external messages need schema version, correlation/causation, trust-validated actor and idempotency data. The conceptual state machine below is to be turned into a validated transition matrix before implementation.

## Lifecycle

Agent instance: `registered -> available -> suspended -> available -> retired` (subject to policy). Retiring an instance does not delete task history.

Task: `created -> assigned -> running -> waiting -> running -> completed|failed|cancelled`. A task may transition directly from running to completed/failed/cancelled. Retries create new execution attempts and follow policy. Terminal states are not reopened; a new task handles subsequent objectives.

Execution: `queued -> leased -> running -> checkpointed/waiting -> resumed -> completed|failed|aborted`. Crash recovery can replace a lost attempt. Each transition must carry compare-and-swap/version fencing to avoid concurrent competing ownership.

## Correlation and delivery

Task IDs identify work; correlation IDs link conversations and events; delegation IDs track parent-child assignment. Delivery records are separate from completion state. An agent can have many tasks, while the same objective may have explicitly distinct invocations.
