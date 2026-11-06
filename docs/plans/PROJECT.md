# Agentropy — Execution Planning Baseline (todo-skills approach)

> Status: **Active plan.** 2026-11-04; readiness gates closed and backlog migrated to todo-skills on 2026-11-05 ([signoff](../review/2026-11-05-readiness-signoff.md)). The live queue is [TODO.md](../../TODO.md).
> Method: adapted from [todo-skills](https://github.com/bassemZohdy/todo-skills) v0.2.0 (`/todo-plan`, `/todo-init`, `/todo-add`, `/todo-continue`). Actual skill execution requires an agent with the installed skills, a Git checkout and a test runner. The present artifact is a plan, not a claim that those skill commands ran.

## Goal

Produce an embeddable, provider-neutral Agentropy framework delivering the approved agent/task/capability/runtime contracts through an offline-tested walking skeleton, then progressively harden for A2A and multi-runtime interoperability, without building a separate workflow engine.

## Scope

- Establish architecture/requirements readiness and approved ADRs before any code.
- Prepare a verified, small-leaf execution backlog compatible with todo-skills and its branch-per-task test-first workflow.
- Build M1 walking skeleton in TypeScript **only after ADR-0016 is approved**; validate the latest supported Node.js LTS when starting.
- Implement thin SQLite persistence, direct communication, durable tasks, registry, capabilities, inbox, human actions and offline conformance; defer A2A to M2.
- Add operational/security hardening, pluggable providers and OpenShift/air-gap examples in later milestones subject to review.

## Out of scope

- Starting source-code implementation in the architecture review phase.
- Assuming official Temporal+LangGraph integration for TypeScript; still undecided.
- Forcing OPA, Vault, Keycloak, Postgres, an A2A wire mapping or a particular orchestration engine into the core.
- Migrating the existing `TODO.md` in place without approving the lossless mapping/format switch.
- Automatically granting production readiness after M1.

## Lanes

- `contracts`: core types, schemas, capability/profile, agent/communication and state contracts; independent of `docs` once readiness closes.
- `runtime`: task lifecycle, store, leases/checkpoints/scheduler, effect journal and outbox; depends on `contracts`.
- `collaboration`: conversation, delegation, inbox, human action and direct provider; depends on `contracts` and runtime interfaces.
- `security`: identity, PEP/PDP, delegated authority, secret references and audit acceptance tests; cross-cutting gates; independent test development possible, integration depends on runtime.
- `testkit`: fake clock/model/providers, fault injection, conformance, cross-provider suites; can develop in parallel with the relevant contract.
- `interop`: M2 A2A provider, multi-tenant controls, OTel and third-party capability providers; depends on M1 signoff.
- `ops`: CI, packaging, documentation, measured performance, SQLite→Postgres compatibility and deployment examples; M0/M1 CI can start after tooling decision.

## Decisions

Accepted architecture direction: ADR-0019…0024, with ADR-0024's pre-dispatch eligibility gate retaining existing task states; TypeScript/Node.js/pnpm and SQLite/polling/in-process M1 in ADR-0016/0017; Apache-2.0/DCO and ESLint/Prettier as recorded in ADR-0023 and repository policy. None of these decisions proves a working implementation.

ADR-0025 security failure codes and the ADR-0024 minimal gate shape are accepted design decisions. Still open: executable race/restart conformance, final cross-document acceptance, reproducible dependency lockfile, DCO PR test, and lossless TODO-to-todo-skills migration. The M0-08 smoke-tested scaffold is present. Temporal + LangGraph TypeScript remains explicitly deferred. Earlier Proposed ADRs stay Proposed where provider-specific guarantees are untested.

### Mandatory readiness gates (complete BEFORE /todo-init migration)

| Gate                                  | Required evidence                                                                                                                | Status                                 |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| G0-01 Architecture consistency        | Durability, communication/config and ADR-0024 gate shape and ADR-0025 errors are aligned; runnable race/recovery tests remain M1 | CLOSED (design only)                   |
| G0-02 Requirements completeness       | Requirements traced to the executable [acceptance matrix](acceptance-matrix.json)                                                | CLOSED (design, 2026-11-05)            |
| G0-03 ADR review                      | Individual ADR dispositions recorded; ADR-0027 setup choices accepted; proposals stay proposed                                   | CLOSED (2026-11-05)                    |
| G0-04 Technology/tooling              | Scaffold CI, frozen lockfile (D-28), ADR-0027; DCO PR run tracked separately as TASK-025                                         | CLOSED for implementation (2026-11-05) |
| G0-05 Test scope                      | [M1 security scope accepted](M1-SECURITY-ACCEPTANCE-DECISION.md): SEC-01/02/03/04/07 required; SEC-05/06 full coverage deferred  | CLOSED (design only)                   |
| G0-06 Todo skills migration readiness | 96/96 IDs mapped in the [crosswalk](TODO-ID-CROSSWALK.md#migration-destinations-2026-11-05); `TODO.md` passes todo-skills lint   | CLOSED (2026-11-05)                    |
| G0-07 Final design signoff            | [Readiness signoff](../review/2026-11-05-readiness-signoff.md)                                                                   | CLOSED (2026-11-05)                    |

No gate is marked closed merely because a proposal was written.

## Execution order — proposed

**Wave 0 / readiness:** M0 scaffold exists and passed build/lint/smoke tests; close remaining G0-02/G0-07 review, reproducible lockfile, DCO PR validation and lossless todo-skills migration. Preserve `TODO.md` as the canonical legacy roadmap until migration is confirmed. See [first-wave tasks](FIRST-WAVE.md) and [the staged todo-skills active tree](TODO-SKILLS-ACTIVE-PROPOSAL.md).

**Wave 1 / M1 walking skeleton** (progress in [Status 2026-11-05](#status-2026-11-05)):

1. `ops`: approved pnpm/TS/Node project structure, offline CI, test command and source scaffolding.
2. `contracts` + `testkit`: versioned JSON schemas, error codes, lifecycle tables, agent/capability contracts, fake clock/provider & contract fixtures.
3. `runtime`: SQLite store and transaction boundary; task service, CAS transitions, leases, retries, checkpoints and wake-up registrations.
4. `runtime` + `security`: idempotent effect journal, durable outbox/inbox, authenticated principal and mandatory audit intent on sensitive effects.
5. `collaboration`: direct communication provider/router, delegation, conversation/briefing and authorized human approvals.
6. `testkit`: run J1 (non-LLM price watch), J2 (fake model + approval), AC-01…AC-20 and explicitly approved security tests; record regression results.
7. Gate M1 exit with tests, conformance, no-LLM offline CI, docs and retrospective. **Do not automatically advance to M2.**

**Wave 2 / M2:** A2A inbound/outbound, remote ownership, delegated cross-trust authentication, policy/tenant isolation, worker recovery, OTel, monitoring scale and real reasoning adapter. Prove declared provider guarantees.

**Wave 3 / M3:** compatibility matrices and alternative providers, audited upgrades/migration, Postgres, Kubernetes/OpenShift and air-gapped deployment, benchmarks/SLOs and integrity verification.

## Status 2026-11-05

Live queue: [TODO.md](../../TODO.md). Verified work: `CHANGELOG.md` `[Unreleased]`. Acceptance evidence: [acceptance-matrix.json](acceptance-matrix.json) (31 of 31 criteria verified by drained roots).

| Wave 1 step                                                                             | Lane               | Roots                                    | Status                                                                |
| --------------------------------------------------------------------------------------- | ------------------ | ---------------------------------------- | --------------------------------------------------------------------- |
| 1. Project structure, offline CI, test command                                          | ops                | M0-08, D-28                              | Done                                                                  |
| 2. Schemas, errors, lifecycle tables, contracts, fakes                                  | contracts, testkit | FEAT-011, FEAT-012, FEAT-013, FEAT-022.1 | Done                                                                  |
| 3. SQLite store, task service, CAS, leases, retries, checkpoints, wake-up registrations | runtime            | FEAT-016, FEAT-017, FEAT-018             | Done                                                                  |
| 4. Effect journal, outbox/inbox, audit intent on sensitive effects                      | runtime, security  | FEAT-019, FEAT-022.2                     | Done — audit intents commit with each protected change                |
| 5. Router/direct provider, delegation, conversation/briefing, human approvals           | collaboration      | FEAT-021, FEAT-019, FEAT-020             | Done                                                                  |
| 6. J1, J2, AC-01…AC-20, SEC-01/02/03/04/07                                              | testkit            | FEAT-022, TASK-023                       | Done                                                                  |
| 7. M1 exit gate and retrospective                                                       | contracts          | TASK-024                                 | Done — [retrospective](../review/2026-11-05-m1-retrospective.md)      |

Also delivered outside the original wave list: tool registry/executor (FEAT-014), Agent Skills loader (FEAT-015). Blocked: TASK-025 (DCO run on real pull requests, owner action). Updated 2026-11-06: TASK-026 (design follow-ups), FEAT-027 (M2, nine subtasks) and FEAT-028 (M3, ten subtasks) were drained on 2026-11-05/06; see CHANGELOG. M1, M2 and M3 plan items are verified by their suites; open beyond M3: PostgreSQL server benchmarks and SLOs, live-cluster deployment tests, and the publishing decisions listed in [release packaging](../release.md#owner-decisions). A2A streaming and push notifications (FEAT-029) and publish-ready packages with a packed-tarball check (FEAT-030) were delivered on 2026-11-06. Only TASK-025 (owner action) remains in the backlog.

Feature branches `feat/core-error-contract`, `feat/testkit-fake-clock`, `feat/testkit-fake-model` and `feat/testkit-fault-injector` were merged into `main` by TASK-029 under a one-off, owner-approved DCO exception (see [legacy PR review](../review/2026-11-05-legacy-pr-integration.md#owner-decision--2026-11-05-supersedes-the-pr-outcomes-above)); the DCO gate is unchanged for future PRs. The branches remain on the remote until the owner deletes them.

## Todo-skills activation / compatibility

The currently checked-in `TODO.md` is a multi-section checklist, **not** todo-skills' required `# Active Backlog` + `## 🌳 Task Tree`. The full roadmap has more items than can fit in a 120-line live tree. Do not pretend that `/todo-plan` can directly operate on it.

1. Preserve an archival copy of the previous roadmap and a stable ID crosswalk, including M0/M1/M2/M3, D-, C-, X- IDs and status.
2. In a real local git checkout, install/read the entire todo-skills pack (core plus command skills). Use `/todo-init` to **propose** migration; request confirmation before replacing a free-form TODO.
3. Use `/todo-plan` for the architecture-approved goal. Only the next small wave enters the active tree. Put later waves, architecture decisions and deep decomposition in this plan and milestone notes.
4. Create compact tasks with P0/P1/P2, `low|mid|high` reasoning complexity, optional lane, `Done when:` plus an **actual executable test command**; leaf <=5 touched files. Subdivide just-in-time; document `Depends:` and `Ref:` paths.
5. One branch/worktree per task, tests first, review, targeted verification plus full regression, merge verified changes, drain completed roots to CHANGELOG per `/todo-continue`. Do not claim a command ran in chat if it did not.
6. Configure `.todo/check.sh` and lint/CI once the approved scaffold and test command exist. `/todo-report` creates `docs/status.html` only after the migrated tree is valid.
7. Do not silently push or merge as part of the todo-skills commands; GitHub sync is an explicit separate action.

## Final architecture readiness review

See [architecture readiness report](../review/2026-11-04-architecture-readiness.md) for open issues that remain before implementation signoff. This report is not a claim that executable conformance passed.

## Verification

Before activation, check the readiness matrix, schema/ADR crosslinks, all previous stable IDs, no dropped tasks and no false completed markers. Once implementation exists, use the test commands proven by CI; **do not invent test commands for packages not yet created**.

## M0 decision review

See [M0-DECISION-REVIEW](M0-DECISION-REVIEW.md) for the accepted M1 decisions and remaining technical verification gates.

## Open questions

- TypeScript + Node.js tooling accepted in ADR-0016; concrete versions to validate at setup.
- SQLite/polling/in-process M1 infrastructure accepted in ADR-0017; concrete packages and settings at setup.
- Apache-2.0 LICENSE, DCO CONTRIBUTING and pull-request sign-off workflow are present; actual DCO positive/negative PR tests remain.
- TaskAgent durable-execution and ADR-0024 eligibility gate are accepted; define concrete gate persistence, fencing, failure taxonomy and runnable tests.
- SEC-01/02/03/04/07 are mandatory M1 checks; still need actual test files and CI evidence.
- Approve/verify lossless todo-skills backlog migration after the remaining architecture/documentation signoff and a genuine lockfile.

## Revisions

- 2026-11-04: Initial staged execution plan based on existing architecture, TODO and todo-skills constraints. No implementation or TODO format migration.
- 2026-11-05: Gates closed, legacy TODO archived and migrated (TASK-010).
- 2026-11-05: Status table added after FEAT-011…FEAT-018/FEAT-021 and the TASK-029 branch merge. Lanes unchanged; roots FEAT-011…FEAT-028 in TODO.md. Historical sections above are kept as written.
