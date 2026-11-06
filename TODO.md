# Active Backlog

## 🌳 Task Tree

- [!] **TASK-025** · P1 · low · Verify the DCO workflow on real signed and unsigned pull requests (D-29)
  - Done when: signed PR passes and unsigned PR fails in Actions; `node --test scripts/check-dco.test.mjs`
  - Links: Ref: CONTRIBUTING.md · Lane: ops
  - Blocked: needs real PRs → `gh pr create` n/a (manual) → owner opens one signed and one unsigned test PR and records both run URLs
- [ ] **FEAT-028** · P2 · high · M3: extensibility, PostgreSQL, multi-worker, upgrades and production hardening
  - Done when: M3 plan items verified by their suites; `pnpm check`
  - Links: Ref: docs/plans/M2-M3-PLAN.md#m3 · Depends: FEAT-027 · Lane: ops
  - State: next: decompose
