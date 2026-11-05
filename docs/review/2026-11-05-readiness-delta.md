# Agentropy — Readiness delta after security and isolation clarifications

- Date: 2026-11-05
- Status: **Documentation review completed; implementation readiness not signed off**
- **Follow-up 2026-11-05:** gates closed and drift fixed in the [readiness signoff](2026-11-05-readiness-signoff.md).
- Scope: Follow-up to [2026-11-04 architecture readiness](2026-11-04-architecture-readiness.md), with GitHub main documentation inspected. This is **not** a successful runtime or CI test result.

## Verified documentation baseline

- ADR-0016/0017 establish TypeScript, Node/pnpm and SQLite/polling/direct first-milestone choices.
- ADR-0021 now explicitly distinguishes external MCP/tool discovery, verified registration, authorization to activate or upgrade, and protected invocation. No silent privilege changes, no implied trust from manifest or transport.
- [Operations](../operations.md) distinguishes capacity/lease isolation from process/workspace, network, filesystem and credential sandboxing; implementation guarantees remain unproven.
- [Requirements](../requirements.md) clarifies existing R-09/10/16/27/28/31/32/35 rather than adding duplicate or renumbered requirement IDs.
- [TODO](../../TODO.md) has N-01…N-04 open: MCP approval, concurrent isolation, exploratory task-aware routing, and cross-document traceability.
- M1 security scope remains SEC-01/02/03/04/07, in the [accepted scope decision](../plans/M1-SECURITY-ACCEPTANCE-DECISION.md). Full later-stage security additions require explicit gate review.

## Gate findings

| Gate | Finding | Next concrete evidence |
|---|---|---|
| G0-01 | Architecture direction accepted, including ADR-0024 non-lifecycle pre-dispatch gate and ADR-0025 error taxonomy; no executable proof | Implement fake clock/PDP/store race and restart tests at M1 |
| G0-02 | Partial: security clarifications recorded, but contract & requirements traceability for N-01…N-03 must be signed off | Cross-reference capability/tool lifecycle with error catalog, policies and SEC test IDs |
| G0-03 | Partial: Proposed ADRs remain proposed where mechanisms or guarantees are untested | Confirm M1-specific decision dispositions without blanket acceptance |
| G0-04 | Scaffold previously CI-verified; previous planning snapshots mentioning missing lockfile are stale relative to TODO D-28's cited successful lockfile CI | Independently verify current main CI and real signed/unsigned DCO PR before closure |
| G0-05 | M1 SEC-01/02/03/04/07 scope accepted; no claim tests pass | Runnable negative tests and evidence at M1 |
| G0-06 | Open: legacy TODO not migrated; initial crosswalk snapshot pre-dates N-01…N-04 | Refresh lossless ID crosswalk, keep statuses and validate with actual todo-skills lint |
| G0-07 | Open: cross-document design signoff not yet recorded | Combined review of contracts, docs, tests and milestone scoping |

## Scope boundary and order

1. Complete **N-01** design-to-contract matrix: registration/activation/invocation policy, trust sources, approval, audit and negative tests. Explicitly decide which limited checks join M1 SEC-04 and which remain M2. Never assume MCP adapter ships in M1.
2. Complete **N-02** isolation-level contract: M1 task/tenant state and credential segregation; provider-declared sandboxing is a later capability, with explicit unsupported guarantee errors.
3. Keep **N-03** task-aware routing exploratory for M3+, benchmarked under policy, budget, residency and quality constraints, separate from the M2 reasoning-provider baseline.
4. Complete **N-04** by refreshing TODO-ID-CROSSWALK (including N tasks), G0-02/G0-07 traceability and the first-wave plan; do not migrate TODO before the tested skill workflow.
5. After gate closure, execute M1 contract and testkit leaves, then persistence/runtime, collaboration and security acceptance, with actual offline CI proof before completion claims.

## Documentation drift to fix

The 2026-11-04 readiness report still calls ADR-0025 proposed and M0-08 scaffold unverified, while newer TODO and ADR material records accepted ADR-0025 and a verified scaffold. The first-wave plan also says the lockfile is missing, while TODO D-28 reports it committed and verified. Reconcile these with current GitHub evidence before changing gate statuses.

No source implementation, test run, approval of outstanding gates, or todo-skills migration is implied by this review.
