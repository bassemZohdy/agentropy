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
| R-18 | P2 | Registry federation across runtimes | Remote registries are discoverable under explicit trust configuration with version negotiation. *Was "federation and remote agent discovery"; A2A delegation itself moved to R-32* | ADR-0015 | M3 |
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
| R-34 | P0 | Replay-safe external side effects via step keys | Crash after an external effect but before commit does not repeat the effect on re-run (AC-07) | Agent v1 | M1 |
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
