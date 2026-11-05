# Agentropy — Architecture readiness signoff (TASK-010)

- Date: 2026-11-05
- Reviewer: Claude (acting Principal Architect under the repository owner's 2026-11-05 directive to complete readiness, migrate to todo-skills and implement without per-step approval). The owner may revoke any gate decision below by reopening it in `TODO.md`.
- Inputs: `main` at `ff49452`; [2026-11-04 readiness report](2026-11-04-architecture-readiness.md); [2026-11-05 readiness delta](2026-11-05-readiness-delta.md); all contracts, ADR-0001…0026, requirements, POC scope and plans.
- Scope boundary: this record closes **design** gates. It is not evidence that any AC/SEC check passes; that evidence is the executable matrix below, enforced in CI by `scripts/check-readiness.mjs`.

## Contract inconsistencies found and resolved

| # | Finding | Resolution |
|---|---|---|
| 1 | Capability v1 title said "revision 2" while its history went to 5, out of order | Title/revision corrected to 6, history ordered; CI now checks title vs. history for every contract |
| 2 | Agent v1 history had a literal `\n` row break, skipped revisions 4–5, and listed rev 6 first | History rewritten in order; gap recorded explicitly |
| 3 | Agent v1 rev 6 had two handler-binding mechanisms (`HandlerRegistry` keyed by definition, and `AgentImplementationProvider`) and `Agent.definition` duplicated the binding | `HandlerRegistry` keyed by implementation artifact and owned by the `native-ts` provider; `Agent.definition` removed ([Agent Implementation v1](../contracts/agent-implementation-v1.md)) |
| 4 | `generic` profile existed in `AgentProfileId` but not in the profile table | Added to Capability v1 profile defaults (no required/default capabilities) |
| 5 | `tool-use` capability (`listTools`, `call`) and ADR-0026 `ToolSelection`/`ToolExecutor` were unrelated | `tool-use` is the handler surface; `call` routes to `ToolExecutor` over pinned tools ([Tool v1](../contracts/tool-v1.md)) |
| 6 | `EffectiveCapabilitySnapshot` could not pin implementation, tools or skills, yet rev 6 required them pinned | `AcceptanceSnapshot` (Agent v1 rev 7) extends it; runtime contract pinning list points to it |
| 7 | Skills had no handler access path, so a selected skill was unusable | Read-only `AgentContext.skills` (`SkillAccess`), pinned skills only, no authority ([Skill v1](../contracts/skill-v1.md)) |
| 8 | Several resolution failures (unknown capability, missing step key, skill dependency, untrusted artifact, ambiguous binding) had no error code | Mapping table in [Errors v1](../contracts/errors-v1.md#contract-error-mapping-revision-2) rev 2; **no new codes** |
| 9 | Errors v1 still "Proposed" though ADR-0025 accepted its additions and X-02 depended on it | Accepted for M1 (rev 2) |
| 10 | Communication `durability: "provider-dependent"` was not a canonical level; extension negotiation was prose-only | Canonical levels + `provider-dependent ≡ none` for checks; `extensions` and `RouteRequirements` (rev 4) |
| 11 | No PDP/PEP/audit shape existed, but tools/skills/registries need fail-closed checks in M1 | Minimal [Security v1](../contracts/security-v1.md) (M1 subset of ADR-0021/0024/0025); engines/backends still deferred |
| 12 | ADR index omitted ADR-0026; validator, SQLite driver and range library were still "setup choices" | ADR-0026 indexed; [ADR-0027](../adr/0027-m1-setup-choices.md) fixes Ajv/semver/yaml/`node:sqlite`/placement |
| 13 | Planning docs disagreed on lockfile state (delta finding) | D-28 is complete (lockfile committed, frozen-install CI green); FIRST-WAVE/PROJECT statements updated |

No accepted architectural decision was reversed. Task states, durability levels, the ADR-0024 non-lifecycle gate and the M1 SEC scope are unchanged.

## Gate decisions

| Gate | Decision | Evidence |
|---|---|---|
| G0-01 Architecture consistency | **Closed (design)** | Findings 1–11 resolved; race/recovery proof remains in FEAT-017/FEAT-022 |
| G0-02 Requirements completeness | **Closed (design)** | Every M1 AC/SEC ID mapped to a root and test file in [acceptance-matrix.json](../plans/acceptance-matrix.json); N-01…N-03 traced to FEAT-014/TASK-026 |
| G0-03 ADR review | **Closed** | ADR-0001…0027 dispositions unchanged except ADR-0027 (new, accepted); proposed ADRs stay proposed |
| G0-04 Technology/tooling | **Closed for implementation** | Node 24/pnpm 10.34.9/strict TS scaffold CI and frozen lockfile (D-28) verified; ADR-0027 setup choices. DCO PR enforcement (D-29) is contribution governance, tracked as blocked TASK-025, and does not gate code |
| G0-05 Test scope | **Closed (design)** | Unchanged: SEC-01/02/03/04/07 mandatory for M1 |
| G0-06 Todo-skills migration | **Closed** | Legacy TODO archived verbatim; 96/96 IDs mapped with preserved status; `TODO.md` passes the todo-skills lint (I1–I10) |
| G0-07 Final design signoff | **Closed (this record)** | Contracts, ADRs, requirements, plans and backlog reviewed together |

## Executable acceptance criteria

[`docs/plans/acceptance-matrix.json`](../plans/acceptance-matrix.json) lists AC-01…AC-20, SEC-01/02/03/04/07 and six contract-conformance criteria (`CT-*`), each with its owning root and test file. `node scripts/check-readiness.mjs` (CI) fails if an AC/SEC is unmapped, a root is unknown, or a root is drained to `CHANGELOG.md` while its test file is missing or does not name the criterion. A criterion is therefore "met" only when its root's `Done when` commands passed and the root drained.

## Remaining open items (not readiness blockers)

- D-29 / TASK-025: real signed/unsigned PR run (needs the owner).
- TASK-026: governance, recovery, telemetry, credential, audit and routing follow-ups listed in [DESIGN-FOLLOWUPS](../plans/DESIGN-FOLLOWUPS.md).
- All M1 behavior: FEAT-011…TASK-024.
