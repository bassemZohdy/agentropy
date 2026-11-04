# Agent collaboration and messaging contracts

**Status: proposed design, revision 2 (2026-11-04)**, informed by langgraph-flows' transport-neutral command/query/event model. Revision 2 fixes the retry rule to match [Agent v1](contracts/agent-v1.md), makes agent fields optional for non-agent messages, and adds the `TaskEvent` shape. Errors: [Errors v1](contracts/errors-v1.md).

## Invariants

- Communication is **async-first**: acceptance creates or references a durable DelegatedTask when durability is requested; completion occurs separately.
- Typed **commands** mutate state, **queries** read state, and **events** report authoritative changes. All transports implement the same envelope/authorization rules.
- Conversation agents invoke the delegation/task service; they do not own worker queues, state transitions or provider histories.
- Task and execution are distinct. Recovery of a non-terminal task creates a new Execution; an explicit `retry` of a terminal task creates a **new task** linked by `retryOf`. Terminal tasks are never reopened ([runtime contract](runtime-contract.md)).
- Duplicate messages are expected: compare idempotency keys with immutable command fingerprints. The same key with a different payload is a conflict, not an accepted retry.
- Consumers handle out-of-order events using entity revision, event ID and reconciliation. No exactly-once external side effects are promised.
- Support direct/in-process, persistent outbox, or broker transports as **adapters**, not foundational business semantics.

## Logical envelope

```ts
type MessageKind = "command" | "query" | "event";
interface AgentMessage<T = unknown> {
  schemaVersion: number;
  kind: MessageKind;
  name: string;
  messageId: string;
  correlationId: string;
  causationId?: string;
  idempotencyKey?: string; // mandatory for mutating commands
  tenantId: string;
  agentDefinitionId?: string;        // required when the message targets or originates from an agent
  agentDefinitionVersion?: string;
  agentInstanceId?: string;
  taskId?: string;
  parentTaskId?: string;
  executionId?: string;
  actor: { principalId: string; principalType: "user"|"service"|"agent"; delegatedBy?: string };
  createdAt: string; // ISO 8601
  payload: T;
}
```

Lifecycle events share one payload shape:

```ts
interface TaskEvent {
  eventId: string;
  taskId: string;
  revision: number;            // task revision AFTER the transition; consumers drop revision <= last seen
  type: "taskAccepted" | "taskAssigned" | "taskStarted" | "taskWaiting" | "taskCompleted"
      | "taskFailed" | "taskCancelled" | "taskCancelRequested" | "humanActionRequested"
      | "humanActionResolved" | "agentProgressUpdated";
  status: TaskSnapshot["status"];
  occurredAt: string;
  data?: unknown;              // e.g. progress message, waitingOn, outcome
}
```

`agentProgressUpdated` does not change `status` and reuses the current revision with a per-revision sequence number.

The sending-side actor field is evidence of **claimed** identity, not proof. Trusted gateways/services must derive or verify principals and delegation grants, and reject tenant/actor spoofing.

## Minimum command/query/event catalog

| Class | Examples | Contract notes |
|---|---|---|
| Command | delegateTask, cancelTask, provideHumanInput, claimHumanAction, suspendInstance, resumeInstance (task pause/resume is not in v1) | Authorized, idempotent, versioned, applied by trusted service/runtime |
| Query | discoverAgents, getTask, listAgentTasks, getResult, listInbox | Read authorization; stale/active result is explicit |
| Event | See `TaskEvent.type` above | Immutable event ID, task revision, causation, authenticated producer and replay support |

Future direct agent-to-agent RPC or federation must not bypass this contract and its authorization checks.

## Acceptance, retry, and failures

The API validates schema, ownership, policy and capability support **before accepting** the request. It returns an immutable task reference with status (accepted/queued) or a typed refusal. A bounded `executeAndWait` convenience method may await that same task without creating a second execution model. A transport timeout after submission yields an **unknown-acceptance** state until queried by request/idempotency key; do not blindly start a duplicate task.

The runtime owns valid state transitions and rejects unsupported optional operations **before side effects**. Operator and requester can distinguish unauthorized, capability unavailable, invalid state, expired input, stale version, and transient provider errors.

## Publication and inbox reconciliation

Within a durable boundary, persist task transitions and an outbox event transactionally where supported. Delivery workers lease work, retry transient failure, dedupe consumers and maintain replay cursors. The inbox projects only user-relevant events and reconciles against the authoritative task/runtime state. Reconciliation repairs missing or stale projections; inbox cannot independently advance task state.

## Explicit future choices

Wire encoding (JSON/Protobuf), transport, retry timeout, max payload, API endpoints, cross-language negotiation, and retention are TBD; do not claim interoperability until a tested specification exists.
