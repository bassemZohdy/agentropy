# ADR-0024: Durable pre-dispatch authorization deferral

- Status: **Proposed** (2026-11-04) — requires explicit acceptance and conformance tests
- Scope: Agentropy M0-05 lifecycle/security compatibility; no implementation authorized

## Problem

ADR-0021 requires an accepted durable task to survive a transient PDP outage or expired authorization without dispatching a protected side effect. The canonical runtime contract permits `running → waiting` only through handler yield (T4). It does **not** permit `created/assigned → waiting`. Inventing a status would break the current transition matrix and potentially stale downstream consumers.

## Proposed solution: activation eligibility gate (no new task state)

1. Preserve task status `created` or `assigned` while authorization cannot be established. Keep durable task/queue record, retry policy and effective grant reference; do **not** create an execution or lease and do not invoke a protected handler.
2. Add a **non-lifecycle scheduler/queue eligibility field** or durable gate record (e.g. `nextEligibilityCheckAt`, `blockReason = policy-indeterminate | grant-expired | revoked`, `gateRevision`). This is *not* a `DelegatedTask.status`, a transition, or a new `TaskEvent` lifecycle edge.
3. Before T2 or T3, apply authenticated principal/tenant and current PDP/grant checks. A transient PDP error records a bounded retry/backoff schedule and a safe diagnostic event. Grant expiry/revocation requires independent reauthorization or an authorized wake-up; do not spin retries or automatically renew scope.
4. The poller must persist gate state and eligibility time in the same atomic unit of work as scheduling decisions. Enforce revision/epoch fencing so multiple workers cannot bypass the gate; any authorization cache requires revocation freshness guarantees.
5. `created` and `assigned` remain cancelable and deadline-governed through the existing T9/T10 guards. An authorized administrative action can resolve stalled tasks. The original acceptance and idempotency handle remain readable only to authorized principals.
6. When current policy becomes valid, scheduler may resume normal T2/T3 flow; record both attempts and eventual dispatch. The accepted task is not magically authorized by a previous grant snapshot.
7. Once a handler is running, safe checkpoint/wake-up uses existing T4 as before. Already dispatched external effects preserve confirmed/unknown outcome reconciliation.
8. No `waiting` task may resume merely because time elapsed: use its existing T5 wake-up and fresh authority validation at the protected boundary.

## Alternative rejected for M1 proposal

Adding `created/assigned → waiting` transitions and a new `authorization-blocked` task state would expand schemas, event tables, client projections and all providers before the walking skeleton is proven.

## Required validation before acceptance

- Fail-closed pre-dispatch PDP timeouts in both `created` and `assigned`, with durable deferred queue state after restart and no new protected external effects.
- Revoked/expired grant never automatically authorizes new dispatch; reissued/narrowed grant may re-enable when verified.
- Expiry/cancel are not blocked by the eligibility gate; no busy spin.
- Authorization check and lease creation race is resolved through transaction/revision fencing and a final protected-operation guard; document unavoidable dispatch/revocation timing limitations.
- Replay/idempotency and audit-intent persistence are preserved; duplicate notifications/effects not introduced.

## Decision boundary

This remains a proposal. The exact gate schema, typed error mapping, retry parameters, wake-up strategy and conflict with task deadlines need contract review and tests. Acceptance would allow updating runtime-contract.md and AC scope, not starting implementation.
