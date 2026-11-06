# Active Backlog

## 🌳 Task Tree

- [!] **TASK-025** · P1 · low · Verify the DCO workflow on real signed and unsigned pull requests (D-29)
  - Done when: signed PR passes and unsigned PR fails in Actions; `node --test scripts/check-dco.test.mjs`
  - Links: Ref: CONTRIBUTING.md · Lane: ops
  - Blocked: needs real PRs → `gh pr create` n/a (manual) → owner opens one signed and one unsigned test PR and records both run URLs
- [ ] **FEAT-029** · P2 · medium · A2A 1.0 streaming and push notifications (beyond M3)
  - Done when: `pnpm check` green; A2A suites cover SSE streaming in and out and push-notification configs with an allow-listed webhook sender
  - Links: Ref: docs/contracts/communication-v1.md · Lane: runtime
  - [x] **FEAT-029.1** · P2 · medium · Streaming: inbound `SendStreamingMessage`/`SubscribeToTask` over SSE; outbound SSE subscribe with polling fallback
    - Done when: `pnpm exec vitest run packages/testkit/test/a2a.test.ts`
  - [ ] **FEAT-029.2** · P2 · medium · Push notifications: task push-notification config methods, signed webhook delivery restricted to allow-listed URLs
    - Done when: `pnpm exec vitest run packages/testkit/test/a2a.test.ts`
