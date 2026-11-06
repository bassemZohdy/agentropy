# Active Backlog

## 🌳 Task Tree

- [!] **TASK-025** · P1 · low · Verify the DCO workflow on real signed and unsigned pull requests (D-29)
  - Done when: signed PR passes and unsigned PR fails in Actions; `node --test scripts/check-dco.test.mjs`
  - Links: Ref: CONTRIBUTING.md · Lane: ops
  - Blocked: needs real PRs → `gh pr create` n/a (manual) → owner opens one signed and one unsigned test PR and records both run URLs
- [ ] **FEAT-028** · P2 · high · M3: extensibility, PostgreSQL, multi-worker, upgrades and production hardening
  - Done when: M3 plan items verified by their suites; `pnpm check`
  - Links: Ref: docs/plans/M2-M3-PLAN.md#m3 · Depends: FEAT-027 · Lane: ops
  - [x] **FEAT-028.1** · high · PostgreSQL store adapter on a driver-neutral client port, passing the shared Store conformance suite offline (M3-07)
    - Done when: Postgres store suite passes on embedded PGlite; `pnpm exec vitest run packages/store-postgres/test`
  - [ ] **FEAT-028.2** · high · Multi-worker pool: several runtimes on one store with lease fencing, no double dispatch, fairness and back-pressure (M3-02)
    - State: next: audit transaction callbacks for re-run safety (ADR-0028 rule)
    - Done when: multi-worker suite passes on SQLite file and PGlite stores; `pnpm exec vitest run packages/testkit/test/multi-worker.test.ts`
  - [ ] **FEAT-028.3** · high · Upgrades: store schema migrations, checkpoint codec versions, audited instance version migration and rollback (M3-03, D-07)
    - Done when: upgrade suite passes; `pnpm exec vitest run packages/testkit/test/upgrades.test.ts`
  - [ ] **FEAT-028.4** · mid · Audit retention, legal hold, archive anchors and verified disposal (M3-04, D-21, D-22)
    - Done when: audit-retention suite passes; `pnpm exec vitest run packages/testkit/test/audit-retention.test.ts`
  - [ ] **FEAT-028.5** · mid · Hardening: secret handling, delegated-authority and approval enforcement; decide D-24 items by ADR (M3-05, D-24)
    - Done when: hardening suite passes and the ADR is accepted; `pnpm exec vitest run packages/testkit/test/hardening.test.ts`
  - [ ] **FEAT-028.6** · mid · Second workflow adapter and the cross-provider conformance kit (M3-01, C-05, X-10)
    - Done when: provider conformance passes for both workflow adapters; `pnpm exec vitest run packages/testkit/test/provider-conformance.test.ts`
  - [ ] **FEAT-028.7** · mid · Benchmarks for throughput, latency and recovery with SLOs set from measurements (M3-06)
    - Done when: benchmark suite records numbers and the SLO document cites them; `pnpm exec vitest run packages/testkit/test/benchmarks.test.ts`
  - [ ] **FEAT-028.8** · mid · Self-hosting: container image, Kubernetes/OpenShift manifests and air-gapped install guide (M3-08)
    - Done when: deployment manifests validate offline; `node scripts/check-deploy.mjs`
  - [ ] **FEAT-028.9** · mid · Registry federation and discovery through published agent cards (M3-09)
    - Done when: federation suite passes; `pnpm exec vitest run packages/testkit/test/federation.test.ts`
  - [ ] **FEAT-028.10** · low · API reference, quickstarts, compatibility matrix and the model-routing evaluation (M3-10, N-03)
    - Done when: docs build and link check pass; `node scripts/check-doc-links.mjs`
