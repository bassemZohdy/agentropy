# Active Backlog

## 🌳 Task Tree

- [!] **TASK-025** · P1 · low · Verify the DCO workflow on real signed and unsigned pull requests (D-29)
  - Done when: signed PR passes and unsigned PR fails in Actions; `node --test scripts/check-dco.test.mjs`
  - Links: Ref: CONTRIBUTING.md · Lane: ops
  - Blocked: needs real PRs → `gh pr create` n/a (manual) → owner opens one signed and one unsigned test PR and records both run URLs
- [ ] **TASK-026** · P1 · high · Resolve remaining design follow-ups (governance, recovery, isolation, telemetry, credentials, audit, routing)
  - Done when: each follow-up closed or explicitly deferred in its plan; `node scripts/check-readiness.mjs`
  - Links: Ref: docs/plans/DESIGN-FOLLOWUPS.md · Lane: contracts
  - State: next: decompose
- [ ] **FEAT-027** · P1 · high · M2: always-on scale, A2A interoperability, control, observability and tenancy
  - Done when: M2 plan items verified by their suites; `pnpm check`
  - Links: Ref: docs/plans/M2-M3-PLAN.md#m2 · Depends: TASK-024 · Lane: interop
  - State: next: decompose
- [ ] **FEAT-028** · P2 · high · M3: extensibility, PostgreSQL, multi-worker, upgrades and production hardening
  - Done when: M3 plan items verified by their suites; `pnpm check`
  - Links: Ref: docs/plans/M2-M3-PLAN.md#m3 · Depends: FEAT-027 · Lane: ops
  - State: next: decompose
