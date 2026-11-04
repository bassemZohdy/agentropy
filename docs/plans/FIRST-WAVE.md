# Agentropy — first execution wave for todo-skills

- Status: **Staged, not yet a live todo-skills task tree**
- Date: 2026-11-04
- Method: [todo-skills](https://github.com/bassemZohdy/todo-skills) v0.2 task decomposition, branch-per-task, test-first, exact `Done when` and regression commands
- Source of truth remains [legacy TODO](../../TODO.md) until [lossless migration](TODO-SKILLS-MIGRATION.md) is explicitly activated.

## Starting point

The M0 scaffold now contains Node.js 24 / pnpm 10, TypeScript strict, four package shells, ESLint, Prettier and Vitest. CI verified TypeScript build, lint and a smoke test, but **no domain capabilities exist**. The repo has no committed `pnpm-lock.yaml`; DCO workflow has not been exercised on a PR.

## Lane and dependency plan

| Proposed step | Lane | Complexity | Source | Depends on | Test-first verification / done state |
|---|---|---|---|---|---|
| W0-A | ops | mid | D-28 | M0 scaffold | Generate genuine pnpm lockfile and run `pnpm install --frozen-lockfile && pnpm check` successfully in CI |
| W0-B | ops | mid | D-29 | CI/DCO | Signed PR passes DCO check; unsigned PR fails, and ordinary `pnpm check` stays green |
| W0-C | contracts | high | D-01, D-03…D-24, D-26 | M0 ADR decisions | Final contract traceability review: no contradictory agent states, durability levels, unsupported communication guarantees or audit/telemetry semantics; maintain documented checklist |
| W0-D | backlog | mid | D-27 | W0-A, W0-C | Preserve legacy TODO exactly, produce per-ID migration mapping, switch to a <=120-line todo-skills active tree and run its actual lint from the installed skills |
| W1-A | contracts | mid | M1-01…03 | W0-C, W0-D | Add unit tests for schema validation, typed errors, profile resolution and immutable definition registration; `pnpm exec vitest run packages/core/test/contracts.test.ts` once the file exists |
| W1-B | runtime | high | M1-04…06 | W1-A | Add transition table and CAS/lease tests; `pnpm exec vitest run packages/runtime/test/lifecycle.test.ts` once created |
| W1-C | runtime | high | M1-05…08 | W1-B | Durable SQLite transactions, checkpoint/wakeup/recovery/eligibility-gate tests; `pnpm exec vitest run packages/store-sqlite/test/recovery.test.ts` once created |
| W1-D | collaboration | high | M1-07/09/11 | W1-C | Direct message/idempotency/inbox/approval tests with fake adapters, verified against existing AC IDs |
| W1-E | security + testkit | high | M1-10 | W1-B…D | Implement SEC-01/02/03/04/07, AC-01…20 in offline CI. No real Keycloak/Vault/OPA/LLM/A2A endpoint |
| W1-F | docs + testkit | mid | M1-12/13 | W1-E | Demonstrate J1 price watch and J2 expense approval; CI and documentation prove actual observed behavior |

The verification command listed for a **future test file** is a precise target *to create*, **not a current passing test**. Actual todo-skills `Done when` lines must be checked against real paths after the step's test-first phase. Every leaf should touch <=5 files, with larger rows decomposed before starting.

## Guardrails

- No single task may bypass framework PEPs, invent a new Task lifecycle status, promise exactly-once external effects, or claim provider guarantees without conformance.
- The mandatory security checks for M1 are SEC-01/02/03/04/07. Full SEC-05/06 suites remain M2/M3.
- Only M1 uses direct/in-process communication. A2A and Temporal/LangGraph adapters are separate future implementation tracks.
- Each leaf uses its own branch/worktree, passing targeted test plus full `pnpm check`, review and provenance update before merging.
- A verified branch may be synchronized to GitHub through an explicit GitHub operation; the todo-skills commands themselves do not push.
- No blind migration: archive the legacy TODO and verify every stable M0/M1/M2/M3/D-/C-/X- item has a tracked destination.

## Current activation blockers

- Final cross-document architecture/requirements signoff (G0-02/G0-07).
- Genuine pnpm lockfile and dependency reproducibility (D-28).
- Lossless todo-skills migration and runnable lint in a git checkout (G0-06/D-27).

Until these are closed, this is a planning artifact rather than a claim that `/todo-init`, `/todo-plan` or `/todo-continue` was executed.
