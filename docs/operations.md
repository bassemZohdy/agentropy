# Security, durability, and operations

## Security boundaries

Use explicit user, service and agent identities. Delegation requires an authorization decision and bounded scope; pass the initiating user identity and delegation chain for audit without treating impersonation as the default. Support trusted token exchange or standards-based delegated authority where deployed identity providers allow it. Tenant and user isolation must be enforced for registry discovery, task state, tools, inbox and memory.

Policies bind allowed agent targets, tools, subscriptions, maximum child fan-out/depth, time/budget limits and required approvals. Fail closed if policy checks are unavailable. Persist a tamper-evident audit sequence (subject to retention policy) for identity, intent, delegation, decisions and side effects. Sanitize untrusted tool/event content and guard against prompt injection.

## Application isolation and configuration

Provide per-application context objects so registries, stores, provider clients and settings do not leak across separate app instances in one process. Use explicit configuration precedence, externalized non-secret settings and secret references resolved only by trusted infrastructure; avoid mutable module-global application state. A deterministic fake model/runtime and a reusable provider contract-test suite must be usable offline.

## Durability and recovery

Maintain durable records for tasks, execution state, wake-up conditions, outbox messages and leases when durability is required. A scheduler or event source can be replaceable, but a task must survive worker restarts and duplicate triggers. Use version-based fencing for active executions, bounded retries/backoff and dead-letter or operator-visible failure handling. Side effects require idempotency keys or reconciliation; exactly-once delivery is not guaranteed simply by adopting a workflow engine.

Cancel and instance suspend/resume must have consistent documented semantics across providers; task pause/resume is unsupported in v1 and returns `UnsupportedOperation`. Deployment change or definition version migration is controlled; never resume a checkpoint on an incompatible runtime silently.

## Version-aware deployments

Each accepted task pins its AgentDefinition/Profile and effective capability/provider versions. Runtime adapters must validate history compatibility on replay and support a documented rollout/rollback/drain or migration strategy; immutable version metadata alone cannot guarantee provider replay safety. A local single-process + SQLite development mode, if selected, does not imply safe multi-host HA. Document exactly which state survives API, worker, scheduler, storage or network failure.

## Quarantine an agent instance

There is no separate quarantine state ([ADR-0030](adr/0030-hardening-and-d24-decisions.md)). To isolate a misbehaving instance: (1) `suspendInstance` — no new tasks are accepted; (2) `revokeAuthority(grantRef)` for each grant its running tasks use — handlers get an `AuthorityExpired` abort, their next protected effect is refused and the tasks wait behind the dispatch gate; (3) inspect `listEffects(taskId)` and the audit log (`audit:read`); (4) either `reauthorize` and `resumeInstance`, or cancel the tasks and `retireInstance`. Every step is audited.

## Observability

Trace from user request through delegation, agent instance, task, attempts, provider actions and inbox updates. Track queue lag, task success/failure, recovery rates, duplicate suppression, approval waiting, tool/model usage, latency and tenant quotas. Sensitive prompts, personal data and credentials must be redacted from logs/telemetry.

## Readiness checks

- Restart a worker during a long-running task and validate recovery and no lost objective.
- Duplicate an event; test deterministic deduplication and idempotent side effects.
- Expire a lease during execution; ensure stale worker cannot commit a terminal state.
- Fail model, workflow provider, inbox publish and schedule trigger independently.
- Check tenant and delegated authority boundaries for registry, tools and inbox.
- Verify explicit unsupported-feature errors and compatibility when switching providers.
- Test cancel (including non-cooperative handlers), instance suspend/resume, compensating failures and bounded recursive delegation.

## Retention and compaction

`LocalApp.compact(retainMs, operator)` (a trusted service; run it on a schedule, e.g. daily) removes the standing state of work that is over, in short transactions of 100 tasks each. Nothing is pruned before `retainMs` has passed since the task ended or the record was last used. `retainMs` must be a non-negative number of milliseconds (anything else is `SchemaViolation`). A run reads only what can be due, through indexes (`tasks.compactedAt`, `inboundEvents.at`, `remoteTasks.observedAt`, `memories.expiresAt`, and the status of inbox entries), a page of 100 rows per transaction: tasks that were compacted are not read again, and the counts in `CompactionResult` are added only after a transaction has committed, so a transaction that runs again after a conflict does not count twice. Tasks that ended inside the window are read again by each run until they leave it. A store created by an earlier version gets the new index columns and backfills them at start.

| Collection | Kept | Removed by `compact` |
|---|---|---|
| `tasks` | always (the system of record for `getTask`; marked `compactedAt`) | never |
| `audit`, `auditHeads`, `auditReceipts` | governed by audit retention, holds and disposal (`auditLog.dispose`) | never by `compact` |
| `outbox`, `wakeups`, `subscriptions`, `mailbox`, `effects`, `checkpoints`, `usage`, `humanActions`, `executions`, `pushConfigs`, `a2aHistory`, `idempotency` (delegation records) | while the task is live | rows of tasks that ended before the window (outbox: published rows only) |
| `memories` (agent memory, FEAT-045) | until the entry's TTL ends, or forever when it has none | entries past their expiry, whatever the window (`CompactionResult.memories`) |
| `mailbox` (consumed), `inboundEvents` | inside the window | consumed rows; dedupe records older than the window (duplicate events are only detected inside it) |
| `remoteTasks` | while non-terminal | terminal projections last observed before the window |
| `inbox` | until resolved or acknowledged | entries resolved or acknowledged before the window |
| `instances`, instance idempotency records, `sessions`, `leases`, `gates`, `policyInvalidations`, `auditPolicies`, `auditHolds` | configuration and control state | pruned by their own owners (gates on task end; invalidations after 10 min) |

Deleting task rows themselves is a deployment decision (it makes old task IDs answer `NotFound`); `compact` leaves them.

## Deployment stance

Concrete self-hosting files and the air-gapped procedure: [deployment guide](deployment.md).


Begin with a local deployment and interfaces that permit later Kubernetes/OpenShift and self-hosted/air-gapped operation. HA/DR topology, retention targets and capacity SLOs require measured design and separate signoff; no undocumented production readiness claim.

## Parallel execution isolation — added design acceptance criteria (2026-11-05)

An execution lease limits concurrency but is **not** itself a process, filesystem, network or credential sandbox. Separate logical per-task state isolation (M1) from stronger worker/workspace isolation (later provider-dependent milestones). Providers declare supported isolation levels and fail explicitly when a requested guarantee is unavailable.

Required tests: concurrent tasks from distinct users/tenants cannot access each other's checkpoints, workspace paths, secrets, tool sessions or inbox; leases and budgets enforce limits under simultaneous dispatch; cancellation/lease expiry prevents stale commits; crash/retry never reuses a previous task's privileged context. Test distinct agent instances sharing a definition and concurrent tool invocations. For external workers, add filesystem/network/credential sandbox conformance and document isolation limitations before production claims.
