# Walking skeleton (M1) — scope and acceptance checks

**Status:** Proposed (2026-11-04). Resolves roadmap item M0-07. This is the smallest implementation that proves the core model end to end. Anything not listed here is out of scope for M1.

## Why a walking skeleton

The contracts are broad. Building each component "fully" in turn (registry, then resolver, then runtime …) risks a polished core that has never run a real journey. M1 instead builds every layer thinly, in one process, driven by two user journeys and a fixed set of failure tests.

## Journeys

**J1 — Price watch (no LLM anywhere)**
1. User sends a turn via `AgentService.submitTurn`: "Tell me when ACME drops below 100."
2. The turn task runs the **rule-based** conversational handler (no `reasoning` binding). It recognizes the watch intent, calls `delegation.delegate` (step key `watch:ACME:100`) for the user's monitoring instance with input `{ symbol: "ACME", below: 100 }`, and completes with the reply "A monitoring agent is watching ACME for you."
3. Monitoring handler calls `event-handling.subscribe({ source: "price", filter: { symbol: "ACME" } })` (step key `sub`) and yields `waiting` on `{ kind: "event", subscription }`.
4. Test publishes prices 120, 105, 99 — **back to back, without waiting for the task to go idle**. The mailbox buffers them; each resume consumes the oldest. At 99 the handler calls `notification.notify` (step key `crossed:100`, severity `high`) and completes.
5. User sends a second turn ("anything new?"). Its handler's `conversation.briefing` returns exactly one entry, "ACME is at 99 (below 100)", and the reply includes it.

**J2 — Expense approval (fake model + human action)**
1. A task agent receives `{ amount: 4200, description: "…" }` via `AgentService.delegate`.
2. Handler calls `reasoning.complete` (fake provider returns a fixed risk summary), then `human-input.requestAction` (step key `approval`, `dueAt` = +48h, `onExpiry: "fail-task"`) → `{ requestId }`, and yields on `{ kind: "human-action", requestId }`.
3. The `humanActionRequested` event projects an inbox entry. User approves via `AgentService.provideHumanInput`.
4. Handler resumes with `wakeReason.outcome = "resolved"`, calls the fake `tool-use.call("payout")` (step key `payout`) and completes. Result available via `getResult`.

## Acceptance checks

All checks run offline in CI with a fake clock, fake model and failure injection.

| ID | Check | Requirements |
|---|---|---|
| AC-01 | J1 end to end with no model provider configured: 3 events published back-to-back → 3 activations in order → 1 notification → task `completed` | R-05, R-17 |
| AC-02 | Second turn's briefing includes the J1 entry once; a third turn does not repeat it; an entry whose revision changes is presented again | R-36, R-12 |
| AC-03 | Delegate response dropped by the test transport → retry with same key returns the original handle (even after the target instance is suspended in between); same key + different payload → `IdempotencyConflict` | R-20 |
| AC-04 | Generated test: every unlisted task/execution edge rejected with `InvalidState`; unauthorized caller on a terminal task gets `NotFound`, not `InvalidState` | R-04, R-21 |
| AC-05 | Kill and restart while J1 is `waiting`; next event still wakes it; the same inbound event ID delivered twice is appended to the mailbox once | R-08 |
| AC-06 | Kill during `running`: lease expires, execution `lost`, new attempt (`attempt` 2, same `activation`) succeeds; a write with the old epoch is rejected | R-08 |
| AC-07 | Crash after internal `notification.notify` commits but before task disposition: replay produces one inbox entry. Separately, a fake external provider honoring the same idempotency key returns the original effect; a non-idempotent provider must explicitly advertise at-least-once semantics, not exactly-once | R-34 |
| AC-08 | J2: duplicate approve = no-op; approve then reject = `ActionConflict`; stale `expectedRevision` = `StaleRevision`; non-assignee = `NotAssignee`; separate run with clock +49h → request `expired`, task `failed` | R-24 |
| AC-09 | Forged `actor` in envelope ignored in favor of trusted principal; cross-tenant delegate → `TenantMismatch`; expired grant → `AuthorityExpired`; unauthenticated → `Unauthenticated` | R-27, R-09 |
| AC-10 | J2 task waiting on definition v1; register v2; approve → resumes on the v1 handler. `HandlerRegistry.unregister(v1)` while waiting → task `failed` with `IncompatibleVersion` | R-23 |
| AC-11 | Cancel a `running` handler that ignores `AbortSignal`: after `cancelGracePeriod` the execution is `lost`, task `cancelled`, late result discarded | R-07 |
| AC-12 | Test coordinator delegates two children, waits `child-tasks` `all`; one child fails → coordinator resumes once with both terminal outcomes in `wakeReason.children` | R-05 |
| AC-13 | Runtime configured with `durability: none` rejects a monitoring definition (`durable-execution`) with `GuaranteeUnavailable`; a `specialist` task on it returns a handle with `durability: "none"` and is `NotFound` after restart | R-07, R-08 |
| AC-14 | Two app contexts in one process do not see each other's agents or tasks; whole suite runs with network disabled | R-28 |
| AC-15 | Registry: identical re-registration is a no-op; same `id@version` with different content fails; discovery with the same query/policy returns the same order and hides unauthorized definitions; two instances of one definition run tasks concurrently | R-01, R-06 |
| AC-16 | Resolver: required removal, unknown capability ID, dependency cycle, ambiguous provider and missing step key on an external op each fail with their typed error; swapping a provider changes the snapshot of **new** tasks only | R-02, R-03 |
| AC-17 | Envelope validation: malformed envelope, wrong `schemaVersion`, missing idempotency key on a command are rejected at the boundary; subscribers ignore a replayed `(revision, sequence)` | R-22 |
| AC-18 | Router conformance suite passes against the direct provider; an operation the provider does not declare fails `UnsupportedOperation` | R-31 |
| AC-19 | Crash between transition commit and outbox publish: after restart the relay publishes the event once; consumers see it once | R-29 |
| AC-20 | A monitoring task processes 150 events: checkpoint stays under the configured limit and only the last N execution records are kept | R-37 |

## Mandatory M1 security acceptance extensions — approved scope (2026-11-04)

The design review identified security gaps. **SEC-01, SEC-02, SEC-03, SEC-04 and SEC-07 are now mandatory M1 exit checks**, in addition to AC-01…AC-20. SEC-05 and SEC-06 are deferred as full feature suites to M2/M3; minimal secret redaction and tenant isolation still apply in M1. Specific test file paths will be created with the real testkit (no invented runnable commands).

| Candidate | Expected behavior | Likely milestone |
|---|---|---|
| SEC-01 | PDP unavailable/timeout: a created/assigned task retains durable gate state, no execution lease or protected side effect; after restart/recovery, authorized resume is guarded and auditable | **M1 mandatory**; resilience depth M2 |
| SEC-02 | Grant revoked/expired after acceptance: next protected operation denied, durable task retained and resumed only with verified new authority; no reuse of stale Allow; in-flight effects are not falsely rolled back | **M1 mandatory**; cross-provider cancellation M2 |
| SEC-03 | Mandatory audit intent write fails: protected state change does not commit/report success; crash after committed intent before publish is replayed safely with deduplication | **M1 mandatory**; independent sink M2 |
| SEC-04 | Spoofed actor/tenant/trace claims have no authorization effect; trusted direct ingress and capability invocation enforce PEPs, tenant scope and default deny | **M1 mandatory direct**; remote A2A M2 |
| SEC-05 | Audit read/export across tenants or without independent audit permission is denied without disclosure; legal hold blocks disposal; integrity verification detects tamper | M2 / M3 archive integrity |
| SEC-06 | Missing/rotated credential blocks protected operation without persisting secrets or deleting the durable task; authorized refresh resumes safely | M2 |
| SEC-07 | Human approval from expired/revoked authority or stale action/task revision is refused, with no duplicate protected side effects | **M1 mandatory**; remote approvals M2 |

All five required tests run offline using fake policy/identity/audit providers and injected clock, without live OPA, Vault, Keycloak or A2A endpoints. SEC-01 uses the **accepted non-lifecycle eligibility gate** of [ADR-0024](adr/0024-pre-dispatch-authorization-gate.md), not an `authorization-blocked` task status. These tests must assert state, audit intent and safety outcomes; no conformance claim is made before executable tests pass. SEC-05 audit access/retention/integrity and SEC-06 credential rotation get full implementation in later milestones, while M1 still redacts secrets and prevents tenant leakage.

## Included components (thin)

Core types + JSON Schema validation · error catalog · transition tables · definition registry (in-memory, loaded from code) · instance directory · capability resolver (catalog in [Capability v1](contracts/capability-v1.md), POC-phase capabilities only; `reasoning` and `tool-use` with fake providers) · TaskService/AgentService · runtime + bounded in-process pool with leases and epochs · SQLite store (tasks, executions, checkpoints, wake-ups, effect journal, outbox, inbox, human actions) · polling scheduler for timer/schedule wake-ups · in-process event bus with durable subscriptions and per-task mailboxes · history compaction (last N executions) · outbox relay → inbox projection · `submitTurn` + turn-start briefing (ordering: severity, then time) · direct communication provider + router conformance suite · testkit (fake clock, fake model, failure injection).

## Explicitly out of scope for M1

A2A provider · Postgres · real LLM providers · MCP tools · workflow engines · priority resolver beyond severity ordering · pause/resume · quotas and fairness · OpenTelemetry export (structured logs with correlation IDs only) · UI · multi-process deployment · registry federation.

## Proposed repository layout

```
packages/
  core/        # types, schemas, errors, transition tables, capability catalog, pure resolver — no I/O
  runtime/     # registries, TaskService, runtime, pool, scheduler, router, direct provider, tool executor, skill loader
  store-sqlite/
  store-postgres/  # M3-07, driver-neutral (ADR-0028)
  workflow-conductor/  # M3-01, second WorkflowEngine adapter
  testkit/     # fake clock/model, failure injection, conformance suites (reusable by provider authors)
examples/
  price-watch/       # J1
  expense-approval/  # J2
```

Layout and tooling follow [ADR-0016](adr/0016-implementation-language.md) and [ADR-0017](adr/0017-first-persistence-and-activation.md) once accepted.

## Exit criteria

All AC-01…AC-20 plus SEC-01, SEC-02, SEC-03, SEC-04, and SEC-07 green in offline CI; examples runnable with one command; every contract document updated where the implementation forced a change (with a revision-history row); a short retrospective recorded in the [review folder](review/) listing contract changes for M2.
