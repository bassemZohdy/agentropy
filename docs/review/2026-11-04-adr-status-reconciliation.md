# ADR-0008…0018 status reconciliation (M0 X-01)

- Date: 2026-11-04
- Review result: **No blanket status promotion.** Earlier ADRs include design direction already accepted elsewhere and mechanism choices still pending. This matrix is a review, not a substitute for individual ADR edits or implementation validation.

| ADR | Baseline | Disposition after ADR-0019…0023 | Next action |
|---|---|---|---|
| 0008 Provider-neutral runtime | Proposed | Direction consistent with accepted ADR-0019 and M1 ADR-0017 | Keep Proposed until specific multi-provider portability guarantees are validated |
| 0009 Authorization/governance | Proposed | Security direction accepted via ADR-0021/0022; token/federation details deferred | Keep Proposed for unresolved mechanism details; refer to accepted ADRs |
| 0010 Async-first/task operations | Proposed | Direction consistent with current normative runtime contract | Eligible for acceptance after lifecycle pre-dispatch policy-wait rule is fixed |
| 0011 Versioned messaging | Proposed | Core direction accepted by ADR-0019; A2A mapping extensions remain proposed | Keep Proposed until communication-v1 operations align with five logical families and conformance |
| 0012 Human actions/inbox priority | Proposed | Basic approval/inbox direction retained; advanced shared priority later | Keep Proposed; separate M1 minimal from M2 advanced capabilities |
| 0013 Version pinning | Proposed | Design direction accepted by ADR-0019; concrete migration/compatibility unverified | Keep Proposed for implementation mechanics |
| 0014 Per-app isolation/testkit | Proposed | Architectural approach matches requirements; tooling now accepted | Eligible for acceptance after exact offline test contracts/quality gates resolved |
| 0015 Communication abstraction | Accepted | Preserved; protocol-independent SPI, A2A preferred when remote | No status change |
| 0016 TypeScript tooling | Accepted | TypeScript/Node.js/pnpm/ESM chosen for M1 | Validate dependency versions at setup |
| 0017 First persistence/activation | Accepted | Single-process SQLite WAL + polling + in-process events + transactional outbox | Validate concrete SQLite adapter and persistence semantics |
| 0018 Execution per activation | Proposed | Used as canonical task/execution model in runtime contract; pre-dispatch policy gating unresolved | Keep Proposed until lifecycle complete |

## Invariants and conflicts

- A2A is a preferred interoperability transport, not mandatory for local or M1.
- No core dependency on Temporal, LangGraph, workflow engine or hosted PDP/secret manager.
- No capability silently downgrades durability or authorization requirements.
- TaskAgent now requires `durable-execution` and optional scheduling; specialist/custom may be non-durable.
- An `authorization-blocked` semantic reason is not a persisted task status; runtime contract is the sole state authority.
- A previously accepted ADR principle must not be mistaken for tested production behavior.

## Closeout criteria

X-01 can be marked *reviewed* once this reconciliation has been checked against the ADR index. It must **not** mean that every Proposed ADR has been accepted. Individual ADR revisions and test validations remain tracked separately.

## Links

[Decision review](../plans/M0-DECISION-REVIEW.md) · [Security blueprint](2026-11-04-m0-trust-boundaries.md) · [Runtime contract](../runtime-contract.md).
