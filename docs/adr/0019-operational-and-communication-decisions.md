# ADR-0019: November 4 architecture decisions — operational semantics

- Status: Accepted (architecture direction; implementation and conformance pending)
- Date: 2026-11-04
- Scope: Agentropy requirements/architecture baseline; **not** authorization to start a milestone or implement code.

## Context

The design review identified open choices around default agent capabilities, communication semantics, operational governance, failure recovery, configuration, versioning and tenancy. This ADR records the decisions explicitly agreed in the follow-up discussion and refines (rather than replaces) ADR-0009, ADR-0013 and ADR-0015.

## Decisions

### 1. Agent profile capability defaults

- `TaskAgent` **requires `durable-execution`** (not just `durable-acceptance`): resumable task state, checkpoints and recoverable execution are its baseline guarantee, regardless of whether scheduling is enabled. Implementations must declare and enforce actual guarantees; a volatile or acceptance-only provider cannot bind this profile. Lightweight volatile helpers can use `specialist`/custom profiles, not silently downgrade `task`.
- `Scheduling` is **optional** for `TaskAgent`, and default-enabled for the `MonitoringAgent` profile. A task may run on demand without scheduling.
- Profiles supply defaults; effective capabilities are resolved and checked before task acceptance.

### 2. Pluggable, A2A-inspired agent communication

- Maintain a **protocol-independent, versioned AgentCommunication abstraction**; neither A2A nor any internal transport leaks into agent business contracts.
- The core logical communication families are: **(1) message/request-response, (2) streaming of messages or progress, (3) task creation/delegation and lifecycle operations, (4) inquiries/queries including task status/results, and (5) subscriptions/notifications/events**.
- These are Agentropy semantic operations, **not a claim that A2A defines five one-to-one protocol APIs**. `inquiry` is a logical operation that an adapter may map to a query or an A2A message/task exchange as appropriate.
- Adapters may implement A2A, in-process/internal or custom broker/RPC protocols. A2A is preferred for independently addressable/interoperable agents. Provider metadata declares supported operations and guarantees; unsupported operations fail explicitly. No insecure or lossy silent fallback.
- **Extensibility is required**: provider-specific and future A2A features can be added through negotiated/versioned extensions without changing mandatory core operations. Agent discovery (integrated with Registry) and conversation continuation/context are **optional extensions**, not new mandatory core APIs.
- Distinguish **messaging** (does not imply creating a task) from **delegation** (creates/tracks work); preserve authorization, correlation, idempotency, streaming cancellation and remote-state authority boundaries. See [ADR-0015](0015-pluggable-agent-communication.md).

### 3. Central governance

- Governance is a **core cross-cutting contract and enforcement boundary**, not a requirement for a standalone service at this stage and not wholly delegated to providers.
- Central policy covers agent/task/capability authorization, delegated authority, lifecycle controls, quotas, audit and security floors. Identity/policy providers remain pluggable. Maintain least privilege and tenant-scoped trust boundaries. See [ADR-0009](0009-authorization-and-governance.md).

### 4. Provider failure and recovery

- An infrastructure/provider outage **does not by itself mean that the logical task has failed**.
- Apply bounded/configurable retry and backoff according to task and provider guarantees, retain durable state, and recover with idempotency/replay safeguards.
- Switch providers or migrate state **only on explicitly verified compatibility**, including checkpoint/schema/side-effect semantics; otherwise retain the task in a recoverable waiting/failure-handling state with an explicit reason. Do not silently move a running task to an incompatible provider.
- The runtime must distinguish transport uncertainty/unknown acceptance from confirmed rejection and avoid duplicate effects.

### 5. Configurable scaling policies and measurable NFRs

- Make **concurrency limits, queue/backpressure limits, timeouts, retry budgets, quotas, recovery policies and relevant resource limits configurable** at documented scopes.
- Define **metrics** for active agents, queued/running tasks, throughput, latency, failures and recovery duration. Metrics are observations; **their limit/threshold policies** are configurable, not the measurements themselves.
- Set numerical capacity targets/SLOs after the POC and benchmark evidence; do not invent performance promises now.

### 6. Distinct lifecycle operations

- `suspend`: block new activation and pause/safely checkpoint currently running work when the provider supports it; otherwise surface a pending/unsupported condition and use a documented safe boundary. Do not promise immediate interruption of arbitrary external effects.
- `drain`: reject new work; allow accepted/in-flight work to finish.
- `retire`: permanently remove the agent from new selection/use after in-flight work is resolved or explicitly migrated/cancelled; do not strand tasks.
- `cancelTask`: explicit, authorized cancellation of **one task**, respecting cooperative cancellation and side-effect uncertainty.
- Governance authorizes each operation; task state transitions, agent instance state and execution state remain distinct.

### 7. Configuration inheritance and snapshot

- Resolve configuration in this order: **framework → agent profile → agent definition → agent instance**, with nearer-scope ordinary settings overriding inherited defaults.
- Lower scopes **must not weaken security/policy floors** established at higher trusted scopes. Overrides can narrow permissions, subject to authorization.
- Capture an **effective configuration snapshot at task acceptance** for deterministic behavior/audit. Explicitly classify dynamic safety revocations as runtime policy checks so snapshot pinning never bypasses an urgent access revocation.

### 8. Version pinning and migration

- Published agent definitions are immutable/versioned. At acceptance, pin the agent definition, effective profile/capability versions, provider/build bindings and compatible state/checkpoint schema.
- Existing tasks remain on their pinned versions by default; new deployments and rollbacks affect **new** task selection, not implicit migration of running work.
- Allow only explicit, authorized, audited migration with compatibility/replay/side-effect checks. Block retiring/removing an old version while dependent tasks still require it unless a safe disposition is recorded. See [ADR-0013](0013-version-pinned-agent-executions.md).

### 9. Ownership and multi-tenancy

- Separate **agent ownership and sharing** from **task ownership and authorization**. Agent ownership may be user/team/tenant scoped; each task has its own initiating principal/owner and security context.
- Tenant isolation is mandatory. Sharing an agent **does not** automatically share memory, execution history, credentials, inbox, or tasks.
- Authorize access separately at agent, task and capability boundaries. Enforce user-level task isolation by default; any team/tenant visibility requires explicit policy.
- Cross-tenant A2A communication is an explicit, authorized cross-trust-boundary delegation/exchange, never an implicit shared namespace.

### 10. Message delivery guarantees

- The logical communication contract distinguishes **best-effort** messages from **durable** delivery requirements.
- Best-effort is permitted for non-critical progress/telemetry where loss is explicitly acceptable.
- Commands that change task state and critical notifications/events **require durable acceptance, retry and idempotency** as appropriate for their side-effect semantics. Persist the intent and use a transactional outbox where state and outgoing messages must commit atomically.
- Providers publish delivery capabilities and failure semantics; a route must reject unmet mandatory guarantees rather than downgrade silently.
- At-least-once handling is expected for durable delivery; consumer deduplication/idempotent effects are required. **Do not promise exactly-once network delivery or exactly-once external side effects.**
- A2A protocol conformance must not be conflated with persistence guarantees. Internal and custom providers must pass the same declared-guarantee conformance tests.

### 11. POC observability baseline

- Capture structured, correlated lifecycle events and metrics for delegation attempts/acceptance/completion/failure, task and execution transitions, retry and unknown-acceptance reconciliation, provider delivery outcomes, and recovery after forced process restart.
- Correlate by tenant-scoped identifiers, agent definition/version and instance, task/parent task, execution, message/correlation/causation ID, and provider/route. Never log credentials or raw sensitive user content.
- Minimum POC metrics: delegation accepted/failed counts and latency; completed/failed/cancelled task counts and duration; running/queued tasks; retry/deduplication counts; provider transport failure counts; checkpoint-to-recovery latency and recovered/stranded task counts.
- Use OpenTelemetry-compatible names/semantics where feasible; **full tracing infrastructure and dashboards remain later milestones**. Record benchmark evidence before specifying numeric SLOs; distinguish metric definitions from configurable policy thresholds.

## Explicitly deferred

- **Temporal + LangGraph integration / TypeScript runtime selection details** remain undecided; do not assume a production-ready official TypeScript integration from the Python announcement.
- Codex software-development-agent collaboration and model-computation proof/verification are **optional future examples/extensions**, not new core requirements.
- Numerical SLOs, provider migration formats, advanced identity/token flows, and deployment-specific adapter choices remain validation/implementation work.

## Follow-up (documentation only, until separately authorized)

Update requirements, communication/runtime contracts and conformance tests to reflect the accepted semantics; reconcile older ADR statuses without silently overwriting their remaining open questions. Add actionable tasks to the roadmap. No implementation is approved by this ADR.
