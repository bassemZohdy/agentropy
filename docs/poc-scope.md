# Walking skeleton (M1) — scope and acceptance checks

**Status:** Proposed (2026-11-04). Resolves roadmap item M0-07. This is the smallest implementation that proves the core model end to end. Anything not listed here is out of scope for M1.

## Why a walking skeleton

The contracts are broad. Building each component "fully" in turn (registry, then resolver, then runtime …) risks a polished core that has never run a real journey. M1 instead builds every layer thinly, in one process, driven by two user journeys and a fixed set of failure tests.

## Journeys

**J1 — Price watch (deterministic, no LLM)**
1. User tells the conversational agent: "Tell me when ACME drops below 100."
2. Conversational agent (scripted fake model) calls `delegation.delegate` → monitoring agent instance, input `{ symbol: "ACME", below: 100 }`, and replies "A monitoring agent is watching ACME for you."
3. Monitoring handler subscribes to the `price` event source and yields `waiting` on `{ kind: "event" }`.
4. Test publishes prices 120, 105, 99. Each event is a new activation; at 99 the handler calls `notification.notify` (step key `crossed:100`) and completes.
5. On the user's next turn, the briefing contains exactly one entry: "ACME is at 99 (below 100)."

**J2 — Expense approval (fake model + human action)**
1. A task agent receives `{ amount: 4200, description: "…" }`.
2. Handler calls `reasoning.complete` (fake model returns a fixed risk summary), then `human-input.requestAction` (step key `approval`) and yields on `{ kind: "human-action" }` with `timeoutAt` = +48h, `onExpiry: "fail-task"`.
3. Inbox shows the approval request. User approves through `AgentService.provideHumanInput`.
4. Handler resumes, calls a fake `tool-use.call` "payout" (step key `payout`) and completes. Result available via `getResult`.

## Acceptance checks

All checks run offline in CI with a fake clock, fake model and failure injection.

| ID | Check | Requirements |
|---|---|---|
| AC-01 | J1 completes end to end; 3 events → 3 activations → 1 notification → task `completed` | R-01, R-05, R-17, R-37 |
| AC-02 | Briefing on next turn includes the J1 entry once; a second turn does not repeat it | R-36, R-12 |
| AC-03 | Delegate response dropped by the test transport → retry with same key returns the original handle; different payload with same key → `IdempotencyConflict` | R-20 |
| AC-04 | Generated test: every unlisted task/execution edge rejected with `InvalidState`; unauthorized caller on a terminal task gets `PermissionDenied`/`NotFound`, not `InvalidState` | R-21 |
| AC-05 | Kill and restart the runtime while J1 is `waiting`; next event still wakes it; duplicate delivery of the same event consumes the wake-up once | R-08, R-29 |
| AC-06 | Kill during `running`: lease expires, execution `lost`, new attempt succeeds; a write with the old epoch is rejected | R-08 |
| AC-07 | Crash injected after `notification.notify` returns but before the disposition commits: re-run produces no second inbox entry | R-34 |
| AC-08 | J2: duplicate approve = no-op; approve then reject = `ActionConflict`; stale `expectedRevision` = `StaleRevision`; clock +49h → task `failed` | R-24 |
| AC-09 | Forged `actor` in envelope ignored in favor of trusted principal; cross-tenant delegate denied; expired grant denied | R-27, R-09 |
| AC-10 | J2 task waiting on definition v1; register v2; approve → resumes on v1 handler. Unregister v1 handler → `IncompatibleVersion` | R-23 |
| AC-11 | Cancel a `running` handler that ignores `AbortSignal`: task `cancelled` after grace; late handler result discarded | R-07 |
| AC-12 | Test coordinator delegates two children, waits `all`; one child fails → coordinator resumes with both outcomes | R-05 |
| AC-13 | Runtime declared `durability: none` rejects a `durable-execution` definition with `GuaranteeUnavailable`; a `none` task's handle discloses it | R-07 |
| AC-14 | Two app contexts in one process do not see each other's agents or tasks; whole suite runs with no network access | R-28 |

## Included components (thin)

Core types + JSON Schema validation · error catalog · transition tables · definition registry (in-memory, loaded from code) · instance directory · capability resolver (catalog in [Capability v1](contracts/capability-v1.md), POC-phase capabilities only) · TaskService/AgentService · runtime + bounded in-process pool with leases and epochs · SQLite store (tasks, executions, checkpoints, wake-ups, effect journal, outbox, inbox, human actions) · polling scheduler for timer/schedule wake-ups · in-process event bus · outbox relay → inbox projection · turn-start briefing (simple priority: severity then time) · direct communication provider + router conformance suite · testkit (fake clock, fake model, failure injection).

## Explicitly out of scope for M1

A2A provider · Postgres · real LLM providers · MCP tools · workflow engines · priority resolver beyond severity ordering · pause/resume · quotas and fairness · OpenTelemetry export (structured logs with correlation IDs only) · UI · multi-process deployment · registry federation.

## Proposed repository layout

```
packages/
  core/        # types, schemas, errors, transition tables — no I/O
  runtime/     # TaskService, runtime, pool, resolver, scheduler, router, direct provider
  store-sqlite/
  testkit/     # fake clock/model, failure injection, conformance suites (reusable by provider authors)
examples/
  price-watch/       # J1
  expense-approval/  # J2
```

Layout and tooling follow [ADR-0016](adr/0016-implementation-language.md) and [ADR-0017](adr/0017-first-persistence-and-activation.md) once accepted.

## Exit criteria

All AC-xx green in CI; examples runnable with one command; every contract document updated where the implementation forced a change (with a revision-history row); a short retrospective recorded in the [review folder](review/) listing contract changes for M2.
