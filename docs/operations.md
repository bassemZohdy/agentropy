# Security, durability, and operations

## Security boundaries

Use explicit user, service and agent identities. Delegation requires an authorization decision and bounded scope; pass the initiating user identity and delegation chain for audit without treating impersonation as the default. Support trusted token exchange or standards-based delegated authority where deployed identity providers allow it. Tenant and user isolation must be enforced for registry discovery, task state, tools, inbox and memory.

Policies bind allowed agent targets, tools, subscriptions, maximum child fan-out/depth, time/budget limits and required approvals. Fail closed if policy checks are unavailable. Persist a tamper-evident audit sequence (subject to retention policy) for identity, intent, delegation, decisions and side effects. Sanitize untrusted tool/event content and guard against prompt injection.

## Durability and recovery

Maintain durable records for tasks, execution state, wake-up conditions, outbox messages and leases when durability is required. A scheduler or event source can be replaceable, but a task must survive worker restarts and duplicate triggers. Use version-based fencing for active executions, bounded retries/backoff and dead-letter or operator-visible failure handling. Side effects require idempotency keys or reconciliation; exactly-once delivery is not guaranteed simply by adopting a workflow engine.

Pause/resume/cancel must have consistent documented semantics across providers; unsupported operations produce explicit errors. Deployment change or definition version migration is controlled; never resume a checkpoint on an incompatible runtime silently.

## Observability

Trace from user request through delegation, agent instance, task, attempts, provider actions and inbox updates. Track queue lag, task success/failure, recovery rates, duplicate suppression, approval waiting, tool/model usage, latency and tenant quotas. Sensitive prompts, personal data and credentials must be redacted from logs/telemetry.

## Readiness checks

- Restart a worker during a long-running task and validate recovery and no lost objective.
- Duplicate an event; test deterministic deduplication and idempotent side effects.
- Expire a lease during execution; ensure stale worker cannot commit a terminal state.
- Fail model, workflow provider, inbox publish and schedule trigger independently.
- Check tenant and delegated authority boundaries for registry, tools and inbox.
- Verify explicit unsupported-feature errors and compatibility when switching providers.
- Test pause/resume/cancel semantics, compensating failures and bounded recursive delegation.

## Deployment stance

Begin with a local deployment and interfaces that permit later Kubernetes/OpenShift and self-hosted/air-gapped operation. HA/DR topology, retention targets and capacity SLOs require measured design and separate signoff; no undocumented production readiness claim.
