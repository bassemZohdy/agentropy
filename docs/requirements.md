# Requirements

Requirement IDs are stable for planning. Priority P0 = foundation, P1 = useful first release, P2 = later. "Must" here defines desired behavior, not a statement that it is implemented.

| ID | Priority | Requirement | Acceptance intent |
|---|---|---|---|
| R-01 | P0 | Versioned agent definitions and independently identified agent instances | Multiple instances and executions can use the same definition |
| R-02 | P0 | Profiles declaring required, default and optional capabilities | Invalid or unavailable combinations fail validation |
| R-03 | P0 | Capability descriptors separate intent, configuration and provider binding | Providers may be swapped without changing definitions |
| R-04 | P0 | Explicit delegated tasks, execution attempts and state transitions | Status and ownership traceable end to end |
| R-05 | P0 | Agent-to-agent delegation, progress and result contracts | Bounded, correlated messages; errors handled |
| R-06 | P0 | Registry lookup by agent ID/version, capabilities and permissions | Resolution deterministic and authorization enforced |
| R-07 | P0 | Runtime lifecycle abstraction | Start, checkpoint/suspend, resume, cancel, complete/fail semantics defined |
| R-08 | P0 | Durable-task recovery contract | Crash/restart resumes or safely compensates; no silent loss |
| R-09 | P0 | Least-privilege user/agent authorization and auditable delegated authority | Caller, acting agent, task and tool decision linked |
| R-10 | P1 | Execution pool with bounded concurrency and leases | Logical agents do not monopolize worker capacity while idle |
| R-11 | P1 | Events, schedules, tools and workflow adapters | Timed/event activation without continuous inference |
| R-12 | P1 | Durable user inbox | Progress/results/approval delivered with acknowledgement and replay |
| R-13 | P1 | Visibility and control for assigned agents | Inspect/pause/resume/cancel within policy |
| R-14 | P1 | Pluggable LLM, workflow, scheduler and storage integration | One realistic alternative provider validated |
| R-15 | P1 | Observability | Metrics, tracing, structured logs and causality through delegation |
| R-16 | P1 | Isolation and quotas | User/tenant boundaries and per-agent resource limits |
| R-17 | P1 | No-LLM deterministic agents and AI-enabled agents | Both supported through the same logical model |
| R-18 | P2 | Federation and remote agent discovery | Authorized cross-runtime routing and version compatibility |
| R-19 | P2 | Advanced agent-team user experience | Optional dashboard and configurable status notifications |

## Additional requirements from langgraph-flows architecture review

| ID | Priority | Requirement | Acceptance intent |
|---|---|---|---|
| R-20 | P0 | Asynchronous-first delegation and accepted-task handles | A disconnected conversation does not terminate an accepted task; start timeout is reconciled by idempotency key |
| R-21 | P0 | Single authoritative lifecycle table and capability-guarded operations | Invalid transitions and unsupported cancel/pause/retry/input operations fail with typed errors |
| R-22 | P0 | Versioned, transport-neutral agent command/query/event envelopes | Correlation, causation, principal, idempotency and message versions validated across transports |
| R-23 | P0 | Durable definition and provider version pinning for accepted tasks | Old tasks preserve compatible semantics across rolling upgrades or fail explicitly |
| R-24 | P1 | Stable human action requests and final authoritative authorization | Expired, duplicate, reassigned or conflicting approvals cannot cause repeated or unauthorized effects |
| R-25 | P1 | User-scoped actionable inbox as projection of task events | Inbox is reconciled against runtime; read, presented, delivered and resolved markers remain distinct |
| R-26 | P1 | Shared business, personal and policy priority model | Personal priority cannot downgrade hard business/policy minimums; adjustments have provenance |
| R-27 | P0 | Trusted identity enforcement before delegation and at sensitive actions | Principal spoofing, scope escalation, expired grants and unauthorized discovery fail closed |
| R-28 | P1 | Isolated app contexts, external configuration and offline contract tests | Two app instances do not share mutable state; CI needs no paid model |
| R-29 | P1 | Reliable, pluggable event publication and reconciliation | Outbox restart/lease, replay, duplicate and out-of-order scenarios tested |
| R-30 | P1 | Compatible deployments across stateful process/runtime boundaries | Crash-survival and version compatibility matrix documented per provider |

These are **proposed Agentropy requirements**, derived from patterns documented in [reuse assessment](reuse-from-langgraph-flows.md); none are implemented yet.

## Functional invariants

- A task is not an agent instance, and an execution attempt is not a task.
- An "always-on" identity is a persisted, reactivatable responsibility, not necessarily a continuously running model or worker.
- Delegate/execute actions carry principal, tenant, scope, correlation and task metadata.
- Completion is not synonymous with message delivery; inbox publication and user acknowledgement are separate.
- A requested capability that cannot be provided must fail explicitly rather than be silently ignored.
- A workflow may be inside an agent; workflow-driven and LLM-driven responsibilities can share the same public agent contracts.

## Quality attributes and target validation

State safety, idempotency, bounded retries, at-least-once processing and explicit failure handling are mandatory design goals. Exactly-once effects are not assumed: external side effects require idempotency or reconciliation. Recovery tests must simulate process crashes, lost leases, duplicate incoming events, delayed callbacks, and restarts with outstanding work. Scale, latency, HA and resource SLOs will be specified after baseline measurements instead of inventing targets.
