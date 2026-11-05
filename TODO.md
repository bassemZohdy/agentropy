# Active Backlog

## 🌳 Task Tree

- [ ] **FEAT-022** · P0 · high · Testkit fakes and offline AC-01…AC-20 plus SEC-01/02/03/04/07 suite (M1-10, A-04)
  - Done when: every M1 matrix row passes; `pnpm exec vitest run packages/testkit/test`
  - Links: Ref: docs/plans/acceptance-matrix.json · Depends: FEAT-018, FEAT-019, FEAT-020, FEAT-021 · Lane: testkit
  - [x] **FEAT-022.1** · low · Offline fakes: clock, model, fault injector, policy, audit, grants
    - Done when: fake unit tests pass; `pnpm exec vitest run packages/testkit/test`
  - [x] **FEAT-022.2** · high · ADR-0024 eligibility gate and SEC-01/02/03/04 plus AC-09 security suite
    - Done when: SEC rows pass offline; `pnpm exec vitest run packages/testkit/test/security.test.ts`
  - [ ] **FEAT-022.3** · high · Restart, effect-journal and history suite: AC-05, AC-07, AC-13, AC-20
    - Done when: rows pass on SQLite reopen; `pnpm exec vitest run packages/testkit/test/recovery.test.ts packages/testkit/test/effects.test.ts`
  - [ ] **FEAT-022.4** · mid · App-context isolation with network disabled: AC-14
    - Done when: AC-14 passes; `pnpm exec vitest run packages/testkit/test/isolation.test.ts`
- [ ] **TASK-023** · P0 · mid · Runnable examples price-watch (J1) and expense-approval (J2) (M1-12)
  - Done when: J1/J2 run offline via examples; `pnpm exec vitest run packages/testkit/test/journeys.test.ts`
  - Links: Ref: docs/poc-scope.md#journeys · Depends: FEAT-022 · Lane: collaboration
- [ ] **TASK-024** · P1 · low · M1 retrospective with contract revisions forced by implementation (M1-13)
  - Done when: retrospective recorded and links valid; `node scripts/check-doc-links.mjs`
  - Links: Ref: docs/poc-scope.md#exit-criteria · Depends: TASK-023 · Lane: contracts
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
