# Agentropy — Architecture & Requirements readiness review

- Date: 2026-11-04
- Status: **Design direction substantially aligned; implementation gate NOT yet passed**
- Scope: Current repository contracts and plans (not an executable code audit)

## Confirmed accepted direction

- ADR-0016: strict TypeScript, ESM, pnpm, Node.js LTS and offline Vitest baseline.
- ADR-0017: SQLite WAL single-process M1, polling scheduler, durable outbox and injectable clock.
- ADR-0019: TaskAgent requires `durable-execution`; scheduling optional; protocol-neutral five communication families; central governance and configuration inheritance.
- ADR-0020: OpenTelemetry correlation separate from security audit and identity.
- ADR-0021/0022: scoped delegation, mandatory PEPs and pluggable PDP/CredentialProvider, fail closed, durable security audit and retention access boundaries.
- ADR-0023: Apache-2.0 + DCO.
- ADR-0024: durable pre-dispatch eligibility gate, without adding new task states.
- M1 acceptance: AC-01…AC-20 **and** SEC-01/02/03/04/07, offline. SEC-05/06 full features deferred.
- Communication v1 SPI remains `delegate/send/getTask/cancel/subscribe`; general bidirectional streaming/generic inquiry are explicitly extension territory, not falsely promised for M1.

## Gap matrix (must not be hidden by an accepted ADR)

| Gap | Current status | Blocking what? |
|---|---|---|
| Typed PDP/audit infrastructure errors | ADR-0025 **proposed**; not added to normative error catalog | Final contract closure; negative SEC-01/03 tests |
| Eligibility gate persistence, fairness, fencing and reauthorization event wake | ADR-0024 pattern accepted; precise schema/race behavior not validated | Final runtime contract and SEC-01 |
| Audit intent transaction and effects committed before handler disposition | Architectural agreement and SQLite proposal accepted; no executable proof | SEC-03, durability claims |
| Authentication, cross-tenant ownership and policy bypass | Trust blueprint accepted, but no fake-provider tests run | SEC-02/04/07, M1 exit |
| Historical ADRs 0008…0014/0018 | Individually reviewed, several Proposed | Implementation-specific capabilities, not blanket design blocker when scoped appropriately |
| Language/runtime dependency compatibility | Tech choices accepted; real package versions/scripts and Node support not verified | M0-08 scaffold |
| Todo-skills strict task format | Legacy TODO retained, staged mapping exists; no active skill lint/run | G0-06 backlog migration |
| OpenTelemetry, advanced audit retention and A2A | Architectural baseline accepted; later milestones | Not M1 blockers beyond truthful capability declarations |
| Temporal + LangGraph TypeScript integration | Explicitly deferred | Not an M1 blocker |

## Required decisions before creating source packages

1. Confirm whether to accept/revise [ADR-0025](../adr/0025-security-infrastructure-errors.md) public error names and handling. A PDP timeout must be a blocked protected action, not `PermissionDenied`; an audit failure must not be labeled successful commit.
2. Finalize durable activation gate minimal schema and race/expiry handling, preserving canonical task states.
3. Confirm a design freeze for M1 scoped features and M1 security acceptance; no automatic scope creep.
4. Permit M0-08 scaffold (workspace + tests + CI), then establish verified commands before activating the todo-skills tree.

## Exit-ready artifacts

- [Requirements](../requirements.md)
- [Architecture](../architecture.md)
- [Runtime Contract](../runtime-contract.md)
- [Communication v1](../contracts/communication-v1.md)
- [Capability v1](../contracts/capability-v1.md)
- [POC acceptance](../poc-scope.md)
- [Execution plan](../plans/PROJECT.md)
- [Todo-skills mapping](../plans/TODO-SKILLS-MIGRATION.md)
- [M0 scaffold handoff](../plans/M0-SCAFFOLD-HANDOFF.md)

## Recommendation

Freeze the accepted **architecture direction**, but keep contract closure and implementation readiness separated. First resolve ADR-0025 and eligibility-gate testability, then create M0-08 with real versions and executable checks. Only after the scaffold runs may `todo-skills` safely generate an active backlog with actual Done-when commands. No tests or code have been executed as part of this review.
