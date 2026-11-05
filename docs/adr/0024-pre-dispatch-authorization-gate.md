# ADR-0024: Durable pre-dispatch authorization deferral

- Status: **Accepted** (2026-11-04) — architectural eligibility-gate principle. Implemented 2026-11-05 by FEAT-022.2; conformance in `packages/testkit/test/security.test.ts`; implementation details in [Security v1](../contracts/security-v1.md#m1-implementation-feat-0222)
- Scope: Agentropy M0-05 lifecycle/security compatibility; no implementation authorized

## Problem

ADR-0021 requires an accepted durable task to survive a transient PDP outage or expired authorization without dispatching a protected side effect. The canonical runtime contract permits `running → waiting` only through handler yield (T4). It does **not** permit `created/assigned → waiting`. Inventing a status would break the current transition matrix and potentially stale downstream consumers.

## Accepted solution: activation eligibility gate (no new task state)

1. Preserve task status `created` or `assigned` while authorization cannot be established. Keep durable task/queue record, retry policy and effective grant reference; do **not** create an execution or lease and do not invoke a protected handler.
2. Add a **non-lifecycle scheduler/queue eligibility field** or durable gate record (e.g. `nextEligibilityCheckAt`, `blockReason = policy-indeterminate | grant-expired | revoked`, `gateRevision`). This is *not* a `DelegatedTask.status`, a transition, or a new `TaskEvent` lifecycle edge.
3. Before T2 or T3, apply authenticated principal/tenant and current PDP/grant checks. A transient PDP error records a bounded retry/backoff schedule and a safe diagnostic event. Grant expiry/revocation requires independent reauthorization or an authorized wake-up; do not spin retries or automatically renew scope.
4. The poller must persist gate state and eligibility time in the same atomic unit of work as scheduling decisions. Enforce revision/epoch fencing so multiple workers cannot bypass the gate; any authorization cache requires revocation freshness guarantees.
5. `created` and `assigned` remain cancelable and deadline-governed through the existing T9/T10 guards. An authorized administrative action can resolve stalled tasks. The original acceptance and idempotency handle remain readable only to authorized principals.
6. When current policy becomes valid, scheduler may resume normal T2/T3 flow; record both attempts and eventual dispatch. The accepted task is not magically authorized by a previous grant snapshot.
7. Once a handler is running, safe checkpoint/wake-up uses existing T4 as before. Already dispatched external effects preserve confirmed/unknown outcome reconciliation.
8. No `waiting` task may resume merely because time elapsed: use its existing T5 wake-up and fresh authority validation at the protected boundary.

## Accepted minimal durable gate contract (design shape, not yet implemented)

The gate is scheduler-owned metadata, **not** `DelegatedTask.status`. An implementation may store it in the task row or a dedicated table, but must preserve equivalent atomic semantics:

```ts
type EligibilityBlockReason =
  | "policy-indeterminate"
  | "authority-expired"
  | "authority-revoked";

interface ActivationEligibilityGate {
  taskId: string;
  taskRevision: number; // task CAS guard observed by scheduler
  gateRevision: number; // monotonic gate CAS version
  reason: EligibilityBlockReason;
  nextCheckAt?: string; // present for bounded PDP retry; absent when grant renewal is required
  grantRef?: string; // opaque, tenant-scoped reference; never a bearer token
  lastDecisionAt: string;
  attempt: number; // bounded gate-evaluation count; not Execution.attempt
}
```

- **Atomicity:** each gate update and scheduler requeue/eligibility decision commits in one Store transaction using a gate revision and task revision. An eligibility change is a non-lifecycle diagnostic/security event; it must not fabricate a task transition or bump task `revision` unless the actual task status changes.
- **Lease fence:** the gate is checked inside the transaction that hands out the execution lease (T3), against current verified authority. A previous Allow snapshot never overrides revocation. Following T3, every protected side-effect dispatch still has a current PEP check, acknowledging that externally dispatched effects cannot be instantly revoked.
- **Transient PDP failure:** retain `created`/`assigned`, set `policy-indeterminate`, schedule a bounded next check with jitter/backoff; no execution or lease. On exhaustion, persist operator-visible blocked eligibility and follow configured escalation/deadline policy instead of spinning.
- **Grant expiry/revocation:** retain task, set `authority-expired`/`authority-revoked`, do **not** periodically reacquire privilege. Resume eligibility only from a trusted grant-renewal notification or authorized manual action followed by fresh PDP evaluation.
- **Deadline/cancel:** independently enforce existing T9/T10 with current task revision while gated. No terminal transition is invented. A task can be canceled without first becoming eligible.
- **Wake-up and crash:** persist the gate before acknowledging deferral; worker/poller restart reloads it. Waking a `waiting` task still follows existing T5 and its current policy check. One scheduler owner wins CAS; stale workers cannot lease or commit work.
- **Audit and data safety:** record reason/outcome and redacted identifiers, not credential material. Critical protected mutations require durable audit intent. Failed audit commit is `AuditCommitUnavailable`; unavailable PDP is `PolicyDecisionUnavailable` (ADR-0025). Neither error implicitly authorizes execution.

## Conformance needed for implementation

With a fake clock/PDP/store: verify PDP outage before T2/T3, restart retention, duplicate scheduler attempts, gate CAS/lease fencing, renewal after revocation, deadline and cancel while blocked, no busy retries, denied protected effect, and replay-safe audit/idempotency. This architecture text does not claim the tests have run.

## Alternative rejected for M1 proposal

Adding `created/assigned → waiting` transitions and a new `authorization-blocked` task state would expand schemas, event tables, client projections and all providers before the walking skeleton is proven.

## Required validation before acceptance

- Fail-closed pre-dispatch PDP timeouts in both `created` and `assigned`, with durable deferred queue state after restart and no new protected external effects.
- Revoked/expired grant never automatically authorizes new dispatch; reissued/narrowed grant may re-enable when verified.
- Expiry/cancel are not blocked by the eligibility gate; no busy spin.
- Authorization check and lease creation race is resolved through transaction/revision fencing and a final protected-operation guard; document unavoidable dispatch/revocation timing limitations.
- Replay/idempotency and audit-intent persistence are preserved; duplicate notifications/effects not introduced.

## Decision boundary

The activation-gate pattern is accepted. Exact gate schema, typed error mapping, retry parameters, and checkpoint/revocation races require tests. Acceptance does **not** authorize a source-code implementation or expand AC-01…AC-20 automatically.
