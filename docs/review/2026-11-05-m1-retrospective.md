# 2026-11-05 — M1 walking skeleton retrospective (TASK-024)

**Scope:** the single-process, offline M1 walking skeleton defined in [POC scope](../poc-scope.md). This review records what was delivered, which contract documents the implementation forced to change, and what carries into M2. It makes no production-readiness claim.

## Exit criteria

| Criterion ([POC scope](../poc-scope.md#exit-criteria)) | Status | Evidence |
|---|---|---|
| AC-01…AC-20 plus SEC-01, SEC-02, SEC-03, SEC-04 and SEC-07 green in offline CI | Met | [acceptance-matrix.json](../plans/acceptance-matrix.json): 31 of 31 criteria map to drained roots whose test files name them (`node scripts/check-readiness.mjs`); `pnpm test` runs with the network blocked (`vitest.setup.ts`, AC-14) |
| Examples runnable with one command | Met | `pnpm example:price-watch` (J1) and `pnpm example:expense-approval` (J2); both run in CI and in `packages/testkit/test/journeys.test.ts` |
| Every contract document updated where the implementation forced a change, with a revision-history row | Met | See the table below; `check-readiness.mjs` verifies title revision = latest history row for `docs/contracts/*` |
| Short retrospective listing contract changes for M2 | Met | This document |

Delivered roots: TASK-010, FEAT-011…FEAT-022, TASK-023 and TASK-029 (see [CHANGELOG](../../CHANGELOG.md)).

## Contract changes forced by implementation

| Document | Revision | What the implementation fixed |
|---|---|---|
| [Capability v1](../contracts/capability-v1.md) | 6 → 7 | `CapabilityInvocationContext.stepKey`; `notify` and `requestAction` are journaled platform-internal effects; `dedupeKey` revises one inbox entry; briefing only for turns the inbox owner submitted |
| [Security v1](../contracts/security-v1.md) | 1 → 2 | Dispatch gate actions (`task:dispatch`, `delegation:reauthorize`) and reasons (adds `policy-denied`); in-transaction audit intents with an at-least-once forwarder; grant re-validation at every protected effect |
| [Tool v1](../contracts/tool-v1.md) | 1 → 2 | Invocation step 8 enforced: keyed external tools are refused (`InvalidConfiguration`) on providers without idempotency keys |
| [Runtime contract](../runtime-contract.md) | 2 → 3 | T6 gate case (lost authority or unavailable policy is not a handler failure and does not count an attempt); checkpoint size bound (`checkpointTooLarge`); ADR-0024 gate implemented |
| [Messaging contract](../messaging-contract.md) | 2 → 3 | Outbox row and relay semantics (ordered, at-least-once, stop at first failure); envelope validation; `taskCancelRequested` carries the cancel-request revision with sequence 1 |
| [Human actions](../human-actions.md) | implementation note | Policy checks before state, role eligibility through the PDP, duplicate-decision rule, revoke on terminal task |
| [ADR-0024](../adr/0024-pre-dispatch-authorization-gate.md) | status | Implemented and verified (SEC-01/02) |

Agent v1, Communication v1, Errors v1, Agent Implementation v1 and Skill v1 needed no change. The legacy PR #3 added `ERROR_DEFINITIONS`, `agentropyError()` and `isAgentropyErrorValue()` beside the existing catalog without changing the contract.

## Decisions worth revisiting

- **Facade beyond Agent v1.** `createLocalApp` exposes `getHumanAction`, `reauthorize` and `publishEvent` in addition to the `AgentService` operations. Agent v1 should either add them or move them to an operator/ingress interface (M2 contract revision). *Resolved in Agent v1 rev 8 (FEAT-027.1): `getHumanAction` and `reauthorize` joined `AgentService`; `publishEvent` stays an ingress operation.*
- **Inbox projection policy.** Terminal task events project only for failed child tasks by default; completions are reported through `notification.notify`. Confirm with real conversational usage.
- **Gate deny handling.** A PDP `deny` at dispatch keeps the task gated (`policy-denied`) until reauthorization instead of failing it; there is no terminal edge for "denied before start". Review with ADR-0021 owners.
- **Cancel request revision.** Recording a cancel request on a running task bumps the task revision; the messaging contract now says so. A separate cancel-request record would keep revisions transition-only.
- **One-off DCO exception.** PRs #3–#6 were merged unsigned on the owner's instruction ([legacy PR review](2026-11-05-legacy-pr-integration.md)); the DCO gate is unchanged and TASK-025 still has to prove it on real PRs.

## Known limits carried into M2

- Single process only: in-process event bus, relay and scheduler loop; no lease heartbeat; UTC-only cron.
- The audit forwarder delivers at least once and relies on the sink deduplicating by `auditId`; no independent audit store (SEC-05).
- Credential rotation (SEC-06), remote A2A ingress, MCP/UTCP/REST tool adapters and skill script execution are not implemented.
- Testkit suites import the runtime test harness by relative path; a public, versioned conformance harness is M2 work.
- One PDP round trip per dispatch and per protected effect; no decision caching with revocation freshness yet.

## Next

M2 ([plan](../plans/M2-M3-PLAN.md#m2), FEAT-027) and the design follow-ups (TASK-026) start from this baseline. TASK-025 (DCO on real signed and unsigned PRs) remains blocked on the repository owner.
