# Requirements

**Revision 2 (2026-11-04).** IDs are stable; nothing is renumbered. Revision 2 merges the three previous tables (one of which did not render), turns "acceptance intent" into testable criteria, adds traceability to contracts and milestones, records overlaps instead of silently duplicating, fixes priority conflicts and adds R-34…R-38 found in the [design review](review/2026-11-04-design-review.md).

**Priority:** P0 = fully required in the walking skeleton (M1); P1 = first useful release (M2) — a P1 row marked "M1 (basic)" has a subset delivered in M1, exactly as covered by its ACs; P2 = later (M3+). "Must" describes desired behavior; **nothing is implemented yet**.
**Milestones:** see [TODO.md](../TODO.md). **Acceptance checks** `AC-xx` are defined in [POC scope](poc-scope.md).

## Functional requirements

| ID | P | Requirement | Acceptance criteria | Trace | M |
|---|---|---|---|---|---|
| R-01 | P0 | Versioned, immutable agent definitions and independently identified instances | Two instances of one definition run concurrent tasks with no shared mutable state; re-registering an existing `id@version` with different content is rejected (AC-15) | Agent v1 | M1 |
| R-02 | P0 | Profiles with required/default/optional capabilities | Removing a required capability, an unknown capability ID, or an unsatisfiable dependency fails registration with a typed error (AC-16) | Capability v1 | M1 |
| R-03 | P0 | Capability selections separate intent, config and provider binding | Swapping the provider of a capability changes no definition file; snapshot shows the new provider for new tasks only (AC-16) | Capability v1 | M1 |
| R-04 | P0 | Explicit tasks, executions and state transitions | Every task/execution change produces a revisioned event; history reconstructs who/what/when end to end. *Refined by R-21* | Runtime contract | M1 |
| R-05 | P0 | Agent-to-agent delegation, progress and result contracts | Child task carries parent ID, correlation and narrowed authority; parent can wait on children (`child-tasks` wake-up). *Refined by R-20, R-22* | Agent v1 | M1 |
| R-06 | P0 | Registry lookup by ID/version, capability and permission | Same query + same policy returns the same ordered result; unauthorized definitions are not returned (AC-15) | Registry/runtime | M1 |
| R-07 | P0 | Runtime lifecycle abstraction | Start, yield/wait, wake, retry, cancel, complete and fail behave per the transition tables; pause/resume returns `UnsupportedOperation` in v1 | Runtime contract | M1 |
| R-08 | P0 | Durable-task recovery | Killing the process during `running` and during `waiting` loses no accepted `durable-execution` task (AC-05, AC-06) | Runtime contract | M1 |
| R-09 | P0 | Least-privilege authorization and auditable delegated authority | Audit record links caller, acting instance, task and capability decision; delegation can only narrow scope. *Refined by R-27* | ADR-0009 | M1 |
| R-10 | P1 | Execution pool with bounded concurrency and leases | With pool size N, at most N executions run; 1,000 waiting tasks hold zero leases | Registry/runtime | M2 |
| R-11 | P1 | Event, schedule, tool and workflow adapters | A scheduled and an event-driven agent wake without any model call; each adapter passes the provider conformance suite | Capability v1 | M2 |
| R-12 | P1 | Durable user inbox | Entries survive restart and are replayable from a cursor. *Refined by R-25* | Human actions | M1 (basic) |
| R-13 | P1 | Visibility and control for assigned agents | Owner can list instances and tasks, cancel tasks and suspend/resume instances; non-owners get `NotFound` | Agent v1 | M2 |
| R-14 | P1 | Pluggable LLM, workflow, scheduler and storage | At least one second provider per category (e.g. Postgres store, one workflow engine) passes the same conformance suite | ADR-0008 | M3 |
| R-15 | P1 | Observability | One trace spans user request → delegation → child tasks → inbox entry; logs redact prompts and secrets | Operations | M2 |
| R-16 | P1 | Isolation and quotas | Tenant A cannot read/act on tenant B's registry, tasks, inbox or memory; per-tenant concurrency quota enforced | Operations | M2 |
| R-17 | P0 | Deterministic (no-LLM) and AI-enabled agents share one model | J1 (rule-based conversational + monitoring agents) runs with no model provider configured; J2 uses the fake model through the same handler contract (AC-01) | Agent v1 | M1 |
| R-18 | P2 | Registry federation across runtimes | Remote registries are discoverable under explicit trust configuration with version negotiation. *Was "federation and remote agent discovery"; A2A delegation itself moved to R-32*. Implemented by FEAT-028.9 through A2A agent cards ([Communication v1](contracts/communication-v1.md) rev 7) | ADR-0015 | M3 |
| R-19 | P2 | Advanced agent-team UX | Optional dashboard and configurable status notifications | Collaboration | M3 |
| R-20 | P0 | Async-first delegation and accepted-task handles | Closing the originating session does not affect the task; a lost response is resolved by idempotency key without a duplicate task (AC-03) | Runtime contract, ADR-0010 | M1 |
| R-21 | P0 | Single authoritative transition table and guarded operations | Generated test: every unlisted edge rejected with `InvalidState`; guard order prevents state leakage (AC-04) | Runtime contract | M1 |
| R-22 | P0 | Versioned, transport-neutral command/query/event envelopes | Envelope schema validated at every boundary; events carry task revision; consumers ignore stale `(revision, sequence)` (AC-17) | Messaging contract, ADR-0011 | M1 |
| R-23 | P0 | Version pinning for accepted tasks | Task accepted on v1 keeps running v1 after v2 registers; missing v1 handler fails `IncompatibleVersion` (AC-10) | Runtime contract, ADR-0013 | M1 |
| R-24 | P1 | Authoritative human actions | Duplicate identical decision is a no-op; conflicting or stale-revision decision fails; expiry follows `onExpiry` (AC-08) | Human actions, ADR-0012 | M1 (basic) |
| R-25 | P1 | Inbox as projection with distinct markers | Deleting all inbox entries and replaying events rebuilds them; delivered/presented/read/acknowledged/resolved are independent | Human actions | M2 |
| R-26 | P1 | Shared business/personal/policy priority | Personal adjustment never lowers a policy floor; every adjustment has provenance | Human actions | M2 |
| R-27 | P0 | Trusted identity before delegation and at sensitive actions | Spoofed actor field, cross-tenant target and expired grant all fail closed (AC-09) | Operations, ADR-0009 | M1 |
| R-28 | P1 | Isolated app contexts, external config, offline tests | Two app contexts in one process share no state; full CI runs offline with no paid model (AC-14) | ADR-0014 | M1 (basic) / M2 |
| R-29 | P1 | Reliable, pluggable event publication | Crash between commit and publish still publishes once to consumers (dedup by event ID); out-of-order delivery handled (AC-19 in M1) | Messaging contract | M1 (basic) / M2 |
| R-30 | P1 | Deployment compatibility across stateful boundaries | Per-provider matrix documents which state survives API/worker/scheduler/storage failure | Operations | M3 |
| R-31 | P0 | Pluggable AgentCommunication SPI with routing and provider metadata | Router conformance suite passes against the direct provider; unsupported operations fail explicitly (AC-18) | Communication v1, ADR-0015 | M1 (direct) |
| R-32 | P1 | Standards-based A2A interoperability | An Agentropy agent delegates to and is delegated from an external A2A agent; status, result and cancel mapped | Communication v1 | M2 |
| R-33 | P1 | Provider-aware routing and remote ownership | Route pinned at acceptance; remote task shown as `authority: "remote"`; no downgrade of security/durability. *Was P0; only meaningful once a remote provider exists* | Communication v1 | M2 |
| R-34 | P0 | Replay-safe effects through deterministic step keys and effect journal | Internal effects commit atomically with their journal; externally idempotent providers deduplicate replays; non-idempotent providers explicitly expose at-least-once effects (AC-07) | Agent v1 | M1 |
| R-35 | P1 | Model provider contract with budget accounting | Model calls go through `reasoning`; per-task cost budget enforced with `BudgetExceeded` | Capability v1 | M2 |
| R-36 | P0 | Conversational surface: delegation as a tool and turn-start briefing | Conversational agent delegates via `delegation`; next turn's briefing includes the new inbox entry exactly once (AC-02) | Collaboration | M1 |
| R-37 | P0 | Long-lived responsibilities as cycling tasks | A monitoring task survives ≥ 100 activations with bounded checkpoint size and pruned execution history (AC-20) | ADR-0018 | M1 |
| R-38 | P1 | Data retention and redaction | Retention per entity type configurable; prompts/PII never written to telemetry; deletion of a user's inbox does not delete audit | Operations | M2 |

## Overlaps (kept for ID stability)

R-04 ⊂ R-21 · R-05 ⊂ R-20/R-22 · R-09 ⊂ R-27 · R-12 ⊂ R-25 · R-14 ↔ R-31 (storage/LLM vs communication). When implementing, test against the *refining* requirement; the parent is satisfied by it.

## Functional invariants

- A task is not an instance; an execution is not a task.
- "Always-on" is a persisted, reactivatable responsibility (a non-terminal task), never a continuously running model or worker.
- State-changing actions carry principal, tenant, scope, correlation, task metadata and an idempotency key.
- Completion ≠ message delivery ≠ user acknowledgement.
- A requested capability or guarantee that cannot be provided fails explicitly.
- Workflow-driven and LLM-driven responsibilities share the same public agent contract.

## Quality attributes

State safety, idempotency, bounded retries, at-least-once processing and explicit failure handling are mandatory. Exactly-once external effects are not assumed: they require step keys, provider idempotency or reconciliation. Recovery tests simulate crashes, lost leases, duplicate events, delayed callbacks and restarts with outstanding work. Numeric scale/latency/HA targets will be set after the M1 baseline measurement (M3-06), not invented now.


## Security and governance alignment (2026-11-04; documentation follow-up)

The decisions in [ADR-0019](adr/0019-operational-and-communication-decisions.md), [ADR-0020](adr/0020-opentelemetry-observability.md), [ADR-0021](adr/0021-delegated-authorization.md), and [ADR-0022](adr/0022-security-audit-governance.md) refine existing requirements without renumbering them. See the [security closeout](review/2026-11-04-security-governance-closeout.md) for gaps and suggested tests.

| Existing requirement | Alignment to add to contract / POC acceptance checks |
|---|---|
| R-04, R-07, R-08, R-21 | Model authorization/policy waiting via canonical lifecycle, durable wakeups and guarded transitions; do not introduce ad-hoc states from ADR prose |
| R-05, R-09, R-20, R-27, R-31–R-33 | Non-forgeable principal/agent/tenant, bounded delegation, mandatory PEPs, fail-closed PDP, protected-action reauthorization, A2A trust boundary and cancellation limits |
| R-09, R-22, R-29, R-34 | Durable audit intent and event delivery, transactional outbox/commit semantics, no unaudited protected commit, dedup/recovery, honest unknown external side effects |
| R-12, R-16, R-25, R-28 | Strict per-user/per-tenant access to inbox, registry, tasks, checkpoints, memory and audit; independently authorized audit read/export |
| R-15, R-38 | Trace context never authorizes access; independent unsampled security audit, redaction, retention floor, legal hold, tamper verification and controlled disposal |

These are **accepted design constraints**, not claims that the v1 contract or runnable tests already implement them. Numeric retention durations, legal jurisdiction rules and specific IAM/audit/PDP providers are deferred. Failure, revocation and data-isolation tests must be added to the appropriate milestones before their security acceptance criteria can be considered complete.


## Communication and configuration contract alignment (2026-11-04)

- [Communication v1](contracts/communication-v1.md#logical-communication-families-and-v1-spi-coverage-adr-0019) maps the five A2A-inspired logical families to existing `delegate`, `send`, `getTask`, `cancel` and `subscribe` operations; generic inquiry/bidirectional streaming and discovery are optional future extensions, not v1 guarantees. Missing requested operations/guarantees must fail explicitly.
- [Capability v1](contracts/capability-v1.md#effective-configuration-precedence-and-security-floors-adr-0019) defines framework → profile → definition → instance configuration order, immutable acceptance-time snapshot, dynamic revocation checks and mandatory floors. Task profile requires `durable-execution` irrespective of optional scheduling.
- Protocol-specific A2A and remote interoperability conformance belongs to M2, while M1 proves declared direct-provider operations, typed unsupported responses and truthful durability. These clarifications are **documentation-only**, not implementation completion.

## 2026-11-05 design clarifications (no renumbering or priority inflation)

- **R-09 / R-27 / R-31 / R-32:** MCP and third-party tool *discovery* must be distinct from verified registration, policy-approved activation, and current per-invocation authorization. Installation/upgrade/startup-hook changes are protected and audited; auto-enabled privilege escalation is denied. Applies equally to internal, A2A and custom transport paths. See ADR-0021.
- **R-10 / R-16 / R-28:** distinguish capacity/lease limits, logical tenant/task isolation and executable worker/workspace sandbox guarantees. M1 must demonstrate independent task state/credentials and no stale-lease commit; production-grade OS/network isolation belongs to a later provider-specific milestone, with explicit unsupported-guarantee errors.
- **R-35:** retain pluggable reasoning-model selection in M2. **Task-aware model routing** (task type, quality constraints, budget, latency, provider availability, policy and residency) is an optional M3+ enhancement; no automatic cross-provider fallback may weaken authorization, privacy, or guarantee contracts. Validate quality/cost against a fixed offline evaluation set before adoption.
- **Security acceptance additions:** deny tool execution after discovery-only; deny unauthorized installation, upgrades and startup hooks; fail closed on a revoked grant or PDP outage; log independent activation and invocation decisions. **Isolation acceptance additions:** two tenants, two instances and concurrent tasks remain segregated under retries/crashes. These are *planned* tests and do not expand the approved M1 SEC set without readiness-gate review.

## 2026-11-05 — Tool Integration abstraction (ADR-0026)

- **R-03/R-06/R-27/R-35:** Agents consume protocol-neutral ToolRegistry/ToolExecutor contracts and canonical tool descriptors; provider bindings may use MCP, UTCP, REST/OpenAPI or custom implementations. Agent capabilities and callable tools are separate concepts.
- **R-09/R-27:** Discovery never implies authorization. Registration, activation/upgrade and each protected invocation must enforce trusted identity, tenant, scoped delegation, revocation, credential safety and mandatory audit independently of the protocol (ADR-0021).
- **R-28/R-30:** Providers declare negotiated features and limitations; schema validation, normalized errors, bounded timeouts, safe idempotency/retry, uncertain outcomes, cancellation and fallback must not weaken authorization or guarantee contracts.
- **Acceptance (planned, not implemented):** same logical tool runs via two adapters without Agent code changes; negative security and failure-injection tests verify framework enforcement. Test milestones and approved SEC scope remain subject to readiness review.

See [ADR-0026](adr/0026-protocol-agnostic-tool-integration.md) and the T-01…T-04 tasks in [TODO](../TODO.md).

## 2026-11-05 — Standard Agent Skills (ADR-0026; contract amendment pending)

- **R-01/R-02/R-03:** AgentDefinition must be able to reference immutable/version-resolved standard Agent Skills separately from its selected Capabilities; no Skill-derived implied permissions.
- **R-06/R-27:** SkillRegistry/SkillLoader discover verified Skill metadata first, then read `SKILL.md` and optional resources as needed, preserving standard compatibility. Skill distribution/provenance, activation and updates are governed and auditable.
- **R-09/R-28:** Skill content and scripts are untrusted; scripts/tools require explicit authorized execution and enforce tenant, delegated scope, workspace/credential isolation and sandbox guarantees, with typed unsupported errors.
- **Planned tests:** fixture-based open-standard compatibility; lazy loading; version pinning; required-Skill absence; malicious instructions/scripts; denied unauthorized execution. No M1 scope expansion without readiness approval.
