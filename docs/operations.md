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

## Deployment stance

Begin with a local deployment and interfaces that permit later Kubernetes/OpenShift and self-hosted/air-gapped operation. HA/DR topology, retention targets and capacity SLOs require measured design and separate signoff; no undocumented production readiness claim.

## Parallel execution isolation — added design acceptance criteria (2026-11-05)

An execution lease limits concurrency but is **not** itself a process, filesystem, network or credential sandbox. Separate logical per-task state isolation (M1) from stronger worker/workspace isolation (later provider-dependent milestones). Providers declare supported isolation levels and fail explicitly when a requested guarantee is unavailable.

Required tests: concurrent tasks from distinct users/tenants cannot access each other's checkpoints, workspace paths, secrets, tool sessions or inbox; leases and budgets enforce limits under simultaneous dispatch; cancellation/lease expiry prevents stale commits; crash/retry never reuses a previous task's privileged context. Test distinct agent instances sharing a definition and concurrent tool invocations. For external workers, add filesystem/network/credential sandbox conformance and document isolation limitations before production claims.
