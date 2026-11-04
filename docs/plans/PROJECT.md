# Agentropy — Execution Planning Baseline (todo-skills approach)

> Status: **Staged plan — NOT implementation authorization**. 2026-11-04.
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

Already accepted: ADR-0019…0022 design directions and earlier unambiguous architectural invariants. **Not approved yet:** ADR-0016 language/tooling; ADR-0017 storage/scheduler/transport; license; several earlier proposed ADRs; exact security-wait lifecycle behavior; M1 security test scope.

### Mandatory readiness gates (complete BEFORE /todo-init migration)

| Gate | Required evidence | Status |
|---|---|---|
| G0-01 Architecture consistency | Task durability contract reconciled; pre-dispatch eligibility gate accepted in ADR-0024; detailed races/route conformance remain test work | PARTIAL |
| G0-02 Requirements completeness | Communication families and configuration precedence reconciled; failure/security contract tests and final cross-document review remain | PARTIAL |
| G0-03 ADR review | Individual ADR-0008…0018 dispositions recorded; proposals with unresolved implementation mechanisms remain proposed | PARTIAL |
| G0-04 Technology/tooling | ADR-0016/0017/0023 accepted; canonical LICENSE + CONTRIBUTING and ESLint/Prettier style set; scaffold/CI and dependency version testing pending | PARTIAL |
| G0-05 Test scope | [M1 security scope accepted](M1-SECURITY-ACCEPTANCE-DECISION.md): SEC-01/02/03/04/07 required; SEC-05/06 full coverage deferred | CLOSED (design only) |
| G0-06 Todo skills migration readiness | Lossless ID/priority mapping, runnable test command from a real scaffold, `Done when` per leaf, `TODO.md` <=120 lines and lint pass | OPEN |
| G0-07 Final design signoff | Requirements, architecture, ADRs, contract schemas, documentation indexes and implementation backlog reviewed together | OPEN |

No gate is marked closed merely because a proposal was written.

## Execution order — proposed

**Wave 0 / readiness:** resolve gates G0-01…G0-05, then create testable initial scaffold and migrate to todo-skills only after G0-06/07 approval. Preserve `TODO.md` as the canonical current roadmap until migration is confirmed.

**Wave 1 / M1 walking skeleton:**

1. `ops`: approved pnpm/TS/Node project structure, offline CI, test command and source scaffolding.
2. `contracts` + `testkit`: versioned JSON schemas, error codes, lifecycle tables, agent/capability contracts, fake clock/provider & contract fixtures.
3. `runtime`: SQLite store and transaction boundary; task service, CAS transitions, leases, retries, checkpoints and wake-up registrations.
4. `runtime` + `security`: idempotent effect journal, durable outbox/inbox, authenticated principal and mandatory audit intent on sensitive effects.
5. `collaboration`: direct communication provider/router, delegation, conversation/briefing and authorized human approvals.
6. `testkit`: run J1 (non-LLM price watch), J2 (fake model + approval), AC-01…AC-20 and explicitly approved security tests; record regression results.
7. Gate M1 exit with tests, conformance, no-LLM offline CI, docs and retrospective. **Do not automatically advance to M2.**

**Wave 2 / M2:** A2A inbound/outbound, remote ownership, delegated cross-trust authentication, policy/tenant isolation, worker recovery, OTel, monitoring scale and real reasoning adapter. Prove declared provider guarantees.

**Wave 3 / M3:** compatibility matrices and alternative providers, audited upgrades/migration, Postgres, Kubernetes/OpenShift and air-gapped deployment, benchmarks/SLOs and integrity verification.

## Todo-skills activation / compatibility

The currently checked-in `TODO.md` is a multi-section checklist, **not** todo-skills' required `# Active Backlog` + `## 🌳 Task Tree`. The full roadmap has more items than can fit in a 120-line live tree. Do not pretend that `/todo-plan` can directly operate on it.

1. Preserve an archival copy of the previous roadmap and a stable ID crosswalk, including M0/M1/M2/M3, D-, C-, X- IDs and status.
2. In a real local git checkout, install/read the entire todo-skills pack (core plus command skills). Use `/todo-init` to **propose** migration; request confirmation before replacing a free-form TODO.
3. Use `/todo-plan` for the architecture-approved goal. Only the next small wave enters the active tree. Put later waves, architecture decisions and deep decomposition in this plan and milestone notes.
4. Create compact tasks with P0/P1/P2, `low|mid|high` reasoning complexity, optional lane, `Done when:` plus an **actual executable test command**; leaf <=5 touched files. Subdivide just-in-time; document `Depends:` and `Ref:` paths.
5. One branch/worktree per task, tests first, review, targeted verification plus full regression, merge verified changes, drain completed roots to CHANGELOG per `/todo-continue`. Do not claim a command ran in chat if it did not.
6. Configure `.todo/check.sh` and lint/CI once the approved scaffold and test command exist. `/todo-report` creates `docs/status.html` only after the migrated tree is valid.
7. Do not silently push or merge as part of the todo-skills commands; GitHub sync is an explicit separate action.

## Verification

Before activation, check the readiness matrix, schema/ADR crosslinks, all previous stable IDs, no dropped tasks and no false completed markers. Once implementation exists, use the test commands proven by CI; **do not invent test commands for packages not yet created**.

## M0 decision review

See [M0-DECISION-REVIEW](M0-DECISION-REVIEW.md) for explicit accept/revise/defer recommendations and unresolved implementation gates. No technology or license has been approved by creating that document.

## M0 decision review

See [remaining M0 choices](M0-DECISION-REVIEW.md). These recommendations are not approved decisions.

## Open questions

- TypeScript + Node.js tooling accepted in ADR-0016; concrete versions to validate at setup.
- SQLite/polling/in-process M1 infrastructure accepted in ADR-0017; concrete packages and settings at setup.
- Apache-2.0 and DCO accepted in ADR-0023; publish canonical LICENSE and contribution guidance before M0 closure.
- Clarify the TaskAgent durability contract and pre-dispatch policy waiting.
- Which SEC checks are required at M1 exit?
- Approve the lossless todo-skills backlog migration after the above closure?

## Revisions

- 2026-11-04: Initial staged execution plan based on existing architecture, TODO and todo-skills constraints. No implementation or TODO format migration.
