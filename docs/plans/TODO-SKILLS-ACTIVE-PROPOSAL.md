# Proposed todo-skills active backlog — first implementation slice

- Status: **Review candidate, not activated** (2026-11-04)
- Original 80-item roadmap stays in [TODO.md](../../TODO.md); complete [ID crosswalk](TODO-ID-CROSSWALK.md) preserves the 17 done and 63 open items from its snapshot.
- These proposed IDs belong to a **future** todo-skills task tree, not to the existing legacy task namespace. Confirm migration and check current IDs before assigning them.
- Specification: [todo-skills v0.2](https://github.com/bassemZohdy/todo-skills), [project plan](PROJECT.md), [first-wave breakdown](FIRST-WAVE.md).
- This file is not itself passed to `/todo-continue` and cannot substitute for the officially linted `TODO.md` tree.

## Draft active TODO tree

The following sample is intended to become the near-term active tree **after** exact IDs, test targets and source mapping are revalidated. The initial tasks are deliberately small (S/M) and do not include all M2/M3 backlog.

```markdown
# Active Backlog

## 🌳 Task Tree

- [ ] **TASK-001** · P0 · mid · Verify PR DCO workflow and documented contributor acceptance
  - Done when: a signed PR passes and an unsigned test PR is rejected; `node --test scripts/check-dco.test.mjs`
  - Links: Ref: docs/plans/FIRST-WAVE.md · From: D-29 · Lane: ops

- [ ] **TASK-002** · P0 · high · Perform the final scope and contract readiness review for M1
  - Done when: all required R/AC/SEC mappings and deferred guarantees are accounted for; `node scripts/check-doc-links.mjs`
  - Links: Ref: docs/review/2026-11-04-architecture-readiness.md · From: D-26 · Lane: contracts

- [ ] **FEAT-003** · P0 · mid · Implement versioned ErrorCode definitions and redacted error schema
  - Done when: every accepted v1 ErrorCode has a typed shape and validation cases; `pnpm exec vitest run packages/core/test/errors.test.ts`
  - Links: Ref: docs/contracts/errors-v1.md · Depends: TASK-002 · From: M1-01 · Lane: contracts

- [ ] **FEAT-004** · P0 · high · Implement task lifecycle transition guards in the runtime core
  - Done when: every listed task transition and forbidden edge is covered; `pnpm exec vitest run packages/runtime/test/lifecycle.test.ts`
  - Links: Ref: docs/runtime-contract.md · Depends: FEAT-003 · From: M1-04 · Lane: runtime

- [ ] **FEAT-005** · P0 · mid · Implement immutable AgentDefinition registration and capability resolution validation
  - Done when: registration, conflict, required guarantee and provider selection fixtures pass; `pnpm exec vitest run packages/core/test/registry.test.ts`
  - Links: Ref: docs/contracts/capability-v1.md · Depends: FEAT-003 · From: M1-02 · Lane: contracts

- [ ] **TASK-006** · P0 · mid · Introduce reusable offline fake clock and fault injection in testkit
  - Done when: fake clock advances deterministic scheduler test fixtures; `pnpm exec vitest run packages/testkit/test/fake-clock.test.ts`
  - Links: Ref: docs/poc-scope.md · Depends: FEAT-003 · From: M1-10 · Lane: testkit
```

## Review notes / correctness limits

- The todo-skills rules require exact *executable* `Done when` checks. Commands for FEAT-003…TASK-006 name **tests the task will create**; they do **not** exist or pass yet. The contract-check script alone checks file link targets, not semantic mapping; TASK-002 must add real reviewed evidence, and its Done-when needs a stronger validation command before activation.
- TASK-001's unit-test command verifies only the DCO script, **not** the PR workflow. Its Done-when also needs a CI-result verification step or exact validation command before activation.
- The `From:` ID syntax must be validated against how todo-skills accepts legacy IDs; if unsupported, keep explicit provenance in a separate mapping and remove invalid `From:` fields.
- Every leaf must start with a failing targeted test, then implementation, review and a clean full `pnpm check` regression. Plan one branch/worktree per leaf.
- Keep this tree below 120 lines, with the rest of the legacy tasks in deferred milestone plans. Never destroy the current TODO or claim a migrated tree until the official lint passes on a real checkout.
- D-28 is already completed on main with frozen-lockfile CI, and is intentionally **not** an open task here.

## Approval gate

Review the task set and the no-loss mapping; then perform /todo-init followed by /todo-plan using the installed skills in a git checkout. Replace the legacy TODO only after its archival backup, source-ID mapping, exact executable checks and lint are verified. Until then, this is a planning artifact.
