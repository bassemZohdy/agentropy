# Human actions, priority and proactive inbox policy

**Status:** proposed architecture detail adapted from langgraph-flows' human input, shared priority and user-inbox patterns. Agentropy retains an agent-to-agent task model.

## HumanActionRequest

A request for approval, rejection, text, form or other typed input is created by an authoritative task runtime, not inferred from assistant prose. Minimum fields: `requestId`, `taskId`, `agentInstanceId`, `kind`, `prompt`, `inputSchema`, `assignees/eligibleRoles`, `dueAt`, `revision`, `requestedBy`, `status` and `idempotencyKey` for decisions. Actor identity is resolved by trusted services.

Lifecycle: `pending -> claimed -> resolved | expired | revoked`, `pending -> resolved | expired | revoked`, and `claimed -> pending` when a claim is released or its claim timeout passes. Both state and assignment may change between presentation and response. The runtime contract lists this lifecycle alongside the others.

```ts
interface HumanActionRequest {
  requestId: string;
  taskId: string;
  agentInstanceId: string;
  kind: "approval" | "choice" | "text" | "form";
  prompt: string;                    // rendered by the platform, never trusted as instructions
  inputSchema: JsonSchema;           // approval = { decision: "approve" | "reject", comment? }
  assignees: { principalIds?: string[]; roles?: string[] };
  dueAt?: string;
  onExpiry: "resume-with-timeout" | "fail-task";
  status: "pending" | "claimed" | "resolved" | "expired" | "revoked";
  claimedBy?: string;
  revision: number;
}

interface HumanDecision {
  requestId: string;
  expectedRevision: number;          // the revision the user saw; mismatch -> StaleRevision
  input: unknown;                    // validated against inputSchema
  idempotencyKey: string;
}
```

## Authoritative completion

1. Inbox or UI performs convenience validation and displays current state.
2. On submit, the service authenticates the user and forwards the precise request ID plus idempotency key to the authoritative runtime.
3. Runtime atomically verifies task waiting state, action revision, deadline, claim, assignee, delegated scope and input schema.
4. Duplicate identical requests return the original result; conflicting decisions or changed assignment fail explicitly.
5. Runtime emits a committed change event. Only then does the inbox project `resolved` (not optimistic on click).
6. Expired or rejected actions are reconciled and explained without silently initiating another task.

All approval routes—including chat, web UI and API—must use the same command boundary. An LLM-generated approval statement does **not** replace user authorization.

## User inbox as projection

User-centric, tenant-isolated inbox entries have immutable event/request references and independently tracked markers: **delivered** (reached a client), **presented** (shown in a turn briefing or UI, with the presented revision), **read** (opened by the user), **acknowledged** (user dismissed/confirmed), **resolved** (underlying action or task reached a final state). Markers are timestamps, not a state machine; R-25 refers to this list. The runtime owns work state; the inbox owns user presentation metadata. A task may emit multiple progress updates but only actionable/significant changes should create user-visible entries.

When a conversational turn begins, the main assistant fetches a bounded current, authorized snapshot. Push/SSE may update active clients, but disconnects require durable replay and reconciliation. User-specific briefing avoids repeatedly raising unchanged items; urgency change or a new action revision permits re-presentation.

## Shared effective priority (proposed formula)

`effectivePriority = policyFloor(businessPriority, deadline, organizationalRules, contextualPersonalPriority)`.

The exact ranking algorithm is TBD. Business priority and deadline originate from the delegated task or relevant capability; conversational context can suggest a **justified** personal adjustment. A policy-defined critical floor or expired deadline cannot be downgraded by the LLM. The importance policy determines whether to interrupt immediately, mention briefly or present only on demand. A hard user obligation cannot be muted by personal preference; user context alone never grants authority.

## Failure and acceptance tests

- Parallel chat/UI actions, duplicate approvals, conflicting accept/reject, stale request revisions, reassignment and expiry.
- Cross-user/tenant inbox reads and actions; forgery of request/task IDs; revoked permissions.
- Inbox publication failure, crash-before/after event commit, UI reconnect and idempotent projection replay.
- User offline, several concurrent conversations, revised priority, repeated turn entry and unchanged-item suppression.

## Boundary

Inbox is neither a workflow scheduler nor a second state machine for task execution. The notification policy must not make agent decisions without an authorized user action.
