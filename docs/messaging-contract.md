# Agent collaboration and messaging contracts

**Status: proposed design, revision 3 (2026-11-05)**, informed by langgraph-flows' transport-neutral command/query/event model. Revision 2 fixes the retry rule to match [Agent v1](contracts/agent-v1.md), makes agent fields optional for non-agent messages, and adds the `TaskEvent` shape. Revision 3 records what the M1 implementation (FEAT-019) fixed: the outbox row and relay semantics below, boundary envelope validation, and that recording a cancel request on a running task is a record change, so its `taskCancelRequested` event carries the new revision with sequence 1. Errors: [Errors v1](contracts/errors-v1.md).

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
  revision: number;            // task revision current when the event was committed
  sequence: number;            // 0 for the transition event itself, 1.. for later non-transition events at that revision
  type:
    // transition events (one per applied transition; bump revision)
    | "taskAccepted" | "taskAssigned" | "taskStarted" | "taskWaiting" | "taskCompleted"
    | "taskFailed" | "taskCancelled"
    // non-transition events (do NOT bump revision; increment sequence)
    | "taskCancelRequested" | "agentProgressUpdated" | "notificationCreated"
    | "humanActionRequested" | "humanActionResolved";
  status: TaskSnapshot["status"];
  occurredAt: string;
  data?: unknown;              // e.g. progress message, waitingOn, outcome
}
```

Consumers order and deduplicate by `(revision, sequence)` and by `eventId`; they drop anything `<=` the last seen pair. `notificationCreated.data` is the `notification.notify` input plus `entryId` and `stepKey`; it is the **only** source of user notification inbox entries. `humanActionRequested/Resolved.data` carries the request ID and revision.

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

## Security metadata and mandatory audit intent

The `actor` and `tenantId` envelope fields are **claims and routing context only**, never independent authentication. Trusted ingress supplies verified identities and effective delegated grants to the runtime; a remote A2A peer, internal adapter or custom provider cannot promote caller-supplied metadata into authorization. W3C `traceparent` and other telemetry context are likewise non-authoritative.

All protected state-changing commands pass mandatory framework PEP checks before effect dispatch. A same-key idempotent replay is allowed to recover the original acceptance only after checking whether the requester remains entitled to see it; it never re-grants expired permissions.

For mandatory security audit events, a protected local state change must durably commit the **audit intent** with the authoritative transition (or via a transactionally committed outbox). A remote audit sink may ingest asynchronously: local durability is not evidence of remote delivery. Failed local audit-intent persistence blocks committing a new protected change. An already-dispatched remote effect may need reconciliation rather than presumed rollback. The audit trail is separate from sampled OpenTelemetry and must apply equivalent tenant isolation and redaction.

This is an architectural clarification; the detailed audit event schema and storage provider remain deferred in [ADR-0021](adr/0021-delegated-authorization.md) and [ADR-0022](adr/0022-security-audit-governance.md).

## Publication and inbox reconciliation

Within a durable boundary, persist task transitions and an outbox event transactionally where supported.

**M1 implementation (`packages/runtime/src/outbox.ts`):** each outbox row is one `TaskEvent` plus `tenantId`, `correlationId`, `published` and `attempts`. The relay reads unpublished rows in commit order, hands each to every registered consumer, then marks it published; on a consumer failure it records the attempt and stops, so later rows never overtake an earlier one. A crash before the mark re-delivers after restart: delivery is at-least-once and consumers must be idempotent per `eventId` (the inbox projector is). `AgentService.subscribe` replays committed rows after a `(revision, sequence)` cursor, then follows relay deliveries and ends after the terminal event. Envelopes are validated at the provider boundary (`validateAgentMessage`): malformed envelopes, a `schemaVersion` other than 1 and commands without an idempotency key fail `SchemaViolation`. Delivery workers lease work, retry transient failure, dedupe consumers and maintain replay cursors. The inbox projects only user-relevant events and reconciles against the authoritative task/runtime state. Reconciliation repairs missing or stale projections; inbox cannot independently advance task state.

## Explicit future choices

Wire encoding (JSON/Protobuf), transport, retry timeout, max payload, API endpoints, cross-language negotiation, and retention are TBD; do not claim interoperability until a tested specification exists.
