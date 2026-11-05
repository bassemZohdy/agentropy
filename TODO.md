# Active Backlog

## 🌳 Task Tree

- [!] **TASK-025** · P1 · low · Verify the DCO workflow on real signed and unsigned pull requests (D-29)
  - Done when: signed PR passes and unsigned PR fails in Actions; `node --test scripts/check-dco.test.mjs`
  - Links: Ref: CONTRIBUTING.md · Lane: ops
  - Blocked: needs real PRs → `gh pr create` n/a (manual) → owner opens one signed and one unsigned test PR and records both run URLs
- [ ] **FEAT-027** · P1 · high · M2: always-on scale, A2A interoperability, control, observability and tenancy
  - Done when: M2 plan items verified by their suites; `pnpm check`
  - Links: Ref: docs/plans/M2-M3-PLAN.md#m2 · Depends: TASK-024 · Lane: interop
  - [x] **FEAT-027.1** · mid · Owner visibility and control: list, filter and cancel own tasks; suspend, resume and drain instances with access control (M2-05)
    - Done when: owner-control suite passes; `pnpm exec vitest run packages/testkit/test/owner-control.test.ts`
  - [x] **FEAT-027.2** · mid · Inbox reconciliation and rebuild; briefing policy with urgent vs deferred delivery and a priority resolver with policy floors (M2-03, M2-04)
    - Done when: inbox rebuild and briefing-policy suite passes; `pnpm exec vitest run packages/testkit/test/inbox-policy.test.ts`
  - [x] **FEAT-027.3** · high · Delivery and recovery: transport-neutral outbox lease and replay, provider outage and delayed callbacks, out-of-process activation adapters with deduplication (M2-02, M2-06)
    - Done when: delivery and outage suite passes; `pnpm exec vitest run packages/testkit/test/delivery.test.ts`
  - [x] **FEAT-027.4** · mid · Monitoring at scale: many standing tasks, mailbox back-pressure, lease heartbeat and compaction (M2-01)
    - Done when: scale suite passes with recorded baseline numbers; `pnpm exec vitest run packages/testkit/test/scale.test.ts`
  - [x] **FEAT-027.5** · mid · Workflow-backed deterministic agent and a real reasoning provider adapter with bounded tools and budget (M2-07, M2-08)
    - Done when: workflow and reasoning-provider suites pass offline with recorded fixtures; `pnpm exec vitest run packages/testkit/test/providers.test.ts`
  - [x] **FEAT-027.6** · mid · Observability: OpenTelemetry traces and metrics, correlation through delegation, redaction (M2-10)
    - Done when: telemetry suite passes; `pnpm exec vitest run packages/testkit/test/telemetry.test.ts`
  - [x] **FEAT-027.7** · high · Tenant isolation and quotas, and the full threat model for identity flows (M2-09, M2-11)
    - Done when: tenancy and quota suite passes and the threat model is recorded; `pnpm exec vitest run packages/testkit/test/tenancy.test.ts`
  - [x] **FEAT-027.8** · high · A2A provider (outbound and inbound, remote task mapping, authorization) and a custom broker/RPC provider sample (C-03, C-04)
    - Done when: A2A and custom-provider conformance passes offline; `pnpm exec vitest run packages/testkit/test/a2a.test.ts`
  - [ ] **FEAT-027.9** · mid · Remote targets in delegation.delegate: TaskService routes endpoint targets through the CommunicationRouter with local projection tasks kept in sync with the remote task
    - Done when: remote delegation suite passes offline; `pnpm exec vitest run packages/testkit/test/remote-delegation.test.ts`
- [ ] **FEAT-028** · P2 · high · M3: extensibility, PostgreSQL, multi-worker, upgrades and production hardening
  - Done when: M3 plan items verified by their suites; `pnpm check`
  - Links: Ref: docs/plans/M2-M3-PLAN.md#m3 · Depends: FEAT-027 · Lane: ops
  - State: next: decompose
