# Changelog

This project follows a human-readable changelog. Release versions will be introduced when implementation starts.

## [Unreleased]

### Added

- **FEAT-027** (feat): M2: always-on scale, A2A interoperability, control, observability and tenancy. Ref: docs/plans/M2-M3-PLAN.md#m2. Validated: `pnpm check`. Docs: updated docs/contracts/agent-v1.md, capability-v1.md, communication-v1.md, security-v1.md, tool-v1.md, observability-v1.md, docs/messaging-contract.md, docs/runtime-contract.md, docs/human-actions.md, docs/security/threat-model.md, docs/review/2026-11-05-m2-scale-baseline.md. Notes: M2 delivered for the single-process runtime with pluggable remote providers — owner control, inbox policy, delivery/recovery and activation ingress, scale (heartbeat, back-pressure, compaction), OpenAI-compatible reasoning and workflow engines, OpenTelemetry, tenant quotas and threat model, A2A 1.0 JSON-RPC and custom broker providers, remote delegation with local projections. Not included: A2A streaming/push, multi-node scheduling, PostgreSQL (M3). Includes: FEAT-027.1, FEAT-027.2, FEAT-027.3, FEAT-027.4, FEAT-027.5, FEAT-027.6, FEAT-027.7, FEAT-027.8, FEAT-027.9.
- **FEAT-022** (feat): Testkit fakes and offline AC-01…AC-20 plus SEC-01/02/03/04/07 suite (M1-10, A-04). Ref: docs/plans/acceptance-matrix.json. Validated: `pnpm exec vitest run packages/testkit/test`. Docs: updated docs/contracts/security-v1.md, docs/contracts/tool-v1.md, docs/runtime-contract.md, docs/adr/0024-pre-dispatch-authorization-gate.md. Notes: ADR-0024 dispatch gate (CAS-fenced gates rows, bounded backoff, reauthorize), in-transaction audit intents with AuditForwarder, grant re-validation at protected effects, checkpoint size bound, at-least-once tool enforcement, offline network guard for the whole suite (vitest.setup.ts); testkit suites import the runtime harness by relative path. Includes: FEAT-022.1, FEAT-022.2, FEAT-022.3, FEAT-022.4.
- **FEAT-020** (feat): Human actions: request, claim/release, decide, expire (M1-09). Ref: docs/human-actions.md. Validated: `pnpm exec vitest run packages/runtime/test/human-actions.test.ts`. Docs: updated docs/human-actions.md. Notes: HumanActionService (requestAction, claim/release with timeout, decide, dueAt expiry sweep wired into WakeupService.poll); onExpiry fail-task applies T9 with ActionExpired; terminal tasks revoke open requests; human-action waits with timeoutAt are rejected.
- **FEAT-019** (feat): Outbox relay, TaskEvent publication, inbox projection, submitTurn and briefing (M1-07). Ref: docs/messaging-contract.md. Validated: `pnpm exec vitest run packages/runtime/test/outbox-inbox.test.ts`. Docs: updated docs/messaging-contract.md, docs/contracts/capability-v1.md. Notes: OutboxRelay (at-least-once, ordered, fault hooks), TaskEventStream subscribe, InboxProjector/InboxService (list, mark, briefing), notify journaled with its notificationCreated event, TaskService.submitTurn, validateAgentMessage at the direct provider boundary (AC-17); projection of terminal events is limited by default to failed child tasks.
- **FEAT-018** (feat): Wake-ups: polling scheduler, event bus, durable subscriptions and mailboxes (M1-08). Ref: docs/runtime-contract.md#event-subscriptions-no-lost-events-between-activations. Validated: `pnpm exec vitest run packages/runtime/test/wakeups.test.ts`. Notes: polling evaluates every armed registration (M1 scale); schedules are UTC-only (other timezones fail UnsupportedOperation); human-action wake-ups read the humanActions collection that FEAT-020 writes; IDs are now restart-safe (random UUIDs). Includes: FEAT-018.1.
- **FEAT-017** (feat): TaskService/AgentService, runtime and bounded pool with leases (M1-04, M1-05, A-02). Ref: docs/runtime-contract.md. Validated: `pnpm exec vitest run packages/runtime/test/task-service.test.ts packages/runtime/test/runtime.test.ts packages/runtime/test/implementation-parity.test.ts`. Notes: wake-up firing (T5), the eligibility gate (ADR-0024) and instance persistence across restart are FEAT-018/FEAT-022; leases are not heartbeated in M1 (handlers must finish within leaseMs or are recovered as lost). Includes: FEAT-017.1, FEAT-017.2, FEAT-017.3.
- **FEAT-016** (feat): Store port and node:sqlite adapter with one transaction boundary (M1-06). Ref: docs/adr/0017-first-persistence-and-activation.md. Validated: `pnpm exec vitest run packages/store-sqlite/test`. Notes: the Store port and MemoryStore (durability none) live in @agentropy/core and the reusable defineStoreConformance suite in @agentropy/testkit; SQLite is single-process, not HA. Task/outbox/inbox semantics on top of the store are FEAT-017…FEAT-020. Includes: FEAT-016.1, FEAT-016.2.
- **FEAT-021** (feat): Direct communication provider, router and reusable router conformance suite (M1-11). Ref: docs/contracts/communication-v1.md. Validated: `pnpm exec vitest run packages/runtime/test/router.test.ts`. Notes: the conformance suite lives in @agentropy/testkit (defineCommunicationConformance) for reuse by provider authors; TaskService integration of the direct target is FEAT-017.
- **FEAT-015** (feat): Skill registry and loader for the standard Agent Skills format (S-02, S-03, S-04). Ref: docs/contracts/skill-v1.md. Validated: `pnpm exec vitest run packages/runtime/test/skills.test.ts`. Notes: filesystem source only; remote skill distribution and script execution remain unsupported (UnsupportedOperation).
- **FEAT-014** (feat): Tool registry and executor with PEP, audit and two direct adapters (T-01, T-02, T-03, N-01). Ref: docs/contracts/tool-v1.md. Validated: `pnpm exec vitest run packages/runtime/test/tools.test.ts`. Notes: MCP/UTCP/REST adapters and plugin startup-hook checks are not implemented (no such runtime exists in M1); the negative matrix covers discovery-only, unverified activation, unauthorized activation, suspend/revoke, tenant spoofing, fresh PDP decisions, PDP outage, audit failure, pin changes, credential redaction.
- **FEAT-013** (feat): Definition registry, instance directory, discovery and native-ts implementation provider (M1-03). Ref: docs/contracts/agent-implementation-v1.md. Validated: `pnpm exec vitest run packages/runtime/test/registry.test.ts packages/runtime/test/implementation.test.ts`.
- **FEAT-012** (feat): Pure acceptance resolver: capability catalog/profiles, implementation, tools, skills (M1-02, A-03, D-01). Ref: docs/contracts/capability-v1.md#resolution-algorithm-authoritative-ordering. Validated: `pnpm exec vitest run packages/core/test/resolver.test.ts packages/core/test/acceptance.test.ts`. Docs: updated docs/contracts/agent-implementation-v1.md. Includes: FEAT-012.1, FEAT-012.2.
- **FEAT-011** (feat): Core contract package: error catalog, transition tables, types and JSON Schemas (M1-01, A-01, S-01). Ref: docs/contracts/agent-v1.md. Validated: `pnpm exec vitest run packages/core/test`. Includes: FEAT-011.1, FEAT-011.2, FEAT-011.3.

### Changed

- **TASK-026** (docs): Resolve remaining design follow-ups (governance, recovery, isolation, telemetry, credentials, audit, routing). Ref: docs/plans/DESIGN-FOLLOWUPS.md. Validated: `node scripts/check-readiness.mjs`. Docs: updated docs/plans/DESIGN-FOLLOWUPS.md (resolution ledger), docs/contracts/security-v1.md, docs/contracts/observability-v1.md, docs/contracts/agent-v1.md, docs/contracts/tool-v1.md, docs/contracts/capability-v1.md, docs/runtime-contract.md, docs/review/2026-11-05-tool-protocol-evaluation.md. Notes: 22 follow-ups — 15 closed, 2 partial with remainders owned by FEAT-027.8 (A2A PEP parity) and FEAT-028 (audit retention/legal hold), 5 deferred; enforced by scripts/check-readiness.mjs. Includes: TASK-026.1, TASK-026.2, TASK-026.3, TASK-026.4, TASK-026.5.
- **TASK-024** (docs): M1 retrospective with contract revisions forced by implementation (M1-13). Ref: docs/poc-scope.md#exit-criteria. Validated: `node scripts/check-doc-links.mjs`. Docs: added docs/review/2026-11-05-m1-retrospective.md; updated README.md, docs/plans/PROJECT.md.
- **TASK-023** (docs): Runnable examples price-watch (J1) and expense-approval (J2) (M1-12). Ref: docs/poc-scope.md#journeys. Validated: `pnpm exec vitest run packages/testkit/test/journeys.test.ts`. Docs: updated README.md, docs/plans/TODO-ID-CROSSWALK.md. Notes: new packages/examples workspace package (price-watch, expense-approval) on createLocalApp, the single-process AgentService facade (packages/runtime/src/app.ts) with tool-use and extra operation handlers; pnpm example:price-watch / example:expense-approval; CI runs both examples.
- **TASK-029** (docs): Merge outstanding feature branches into main and refresh plan and status documents. Ref: docs/plans/PROJECT.md#status-2026-11-05. Validated: `node scripts/check-readiness.mjs`. Docs: updated docs/plans/PROJECT.md, docs/plans/TODO-ID-CROSSWALK.md, docs/review/2026-11-05-legacy-pr-integration.md. Notes: merged PRs #3–#6 unsigned as a one-off owner-approved DCO exception (policy unchanged for future PRs): feat/core-error-contract (wire-level error values kept alongside the class), feat/testkit-fake-clock (now the single FakeClock, with ISO start and iso()), feat/testkit-fake-model and feat/testkit-fault-injector; FEAT-022 decomposed with FEAT-022.1 done.
- **TASK-010** (docs): Close architecture readiness: reconcile contracts, sign off gates, migrate the backlog (D-10, D-26, D-27, N-04). Ref: docs/review/2026-11-05-readiness-signoff.md. Validated: `node scripts/check-readiness.mjs`. Docs: updated README.md, docs/contracts/agent-v1.md, docs/contracts/capability-v1.md, docs/contracts/communication-v1.md, docs/contracts/errors-v1.md, docs/contracts/agent-implementation-v1.md, docs/contracts/tool-v1.md, docs/contracts/skill-v1.md, docs/contracts/security-v1.md, docs/adr/0027-m1-setup-choices.md, docs/adr/README.md, docs/runtime-contract.md, docs/poc-scope.md, docs/plans/PROJECT.md, docs/review/2026-11-05-readiness-signoff.md. Includes: TASK-010.1, TASK-010.2.

## Unreleased — 2026-11-04 (pre-todo-skills history)

### Added — M0 workspace scaffold (2026-11-04)

- Created a strict TypeScript/ESM pnpm workspace with `core`, `runtime`, `store-sqlite`, and `testkit` placeholder packages; no agent runtime functionality implemented.
- Added a Vitest smoke test, TypeScript composite build, ESLint, Prettier, and GitHub Actions scaffold CI; [CI run 41861578838](https://github.com/bassemZohdy/agentropy/actions/runs/41861578838) passed all checks.
- Added a pull-request DCO sign-off workflow and validation script; the workflow remains untested against example PRs.
- Published [scaffold verification](docs/review/2026-11-04-m0-scaffold-verification.md), [first-wave todo-skills plan](docs/plans/FIRST-WAVE.md), and follow-ups for lockfile reproducibility/DCO live validation.
- Pinned pnpm 10.34.9 as package manager. The dependency lockfile is still pending; smoke testing does not demonstrate Agentropy's domain AC/SEC suites.

### Added

- Initial README and documented product vision, scope, requirements and logical architecture.
- Agent domain model, capability profiles and registry/pool/runtime design.
- Multi-agent delegation, shared inbox, security and recovery guidelines.
- Architecture decision records ADR-0001…0009 (seven accepted design directions, two proposed).
- Milestone-based implementation roadmap.

- Reviewed [langgraph-flows](https://github.com/bassemZohdy/langgraph-flows) architecture and selectively adapted lifecycle, messaging, inbox, priority, authorization, human actions, versioning and testing requirements.
- Added the cross-project reuse assessment, task runtime contract, agent messaging contract, and human-action/proactive-policy documentation.
- Added ADRs 0010–0014 as proposed decisions and expanded architecture/requirements/roadmap references.
- No source code or external runtime dependency was copied.

- Finalized initial Agent v1 and Capability v1 architecture contracts covering profile resolution, agent identity, lifecycle ownership, provider guarantees, authorization, version pinning and conformance criteria.

- Adopted ADR-0015: transport-neutral agent communication with internal, A2A and custom provider implementations, and documented a Communication Contract v1 architecture baseline.

### Changed — re-review (2026-11-04)

Independent re-review after merging the design review found 25 issues, all fixed ([review record](docs/review/2026-11-04-design-review.md#re-review-after-merge)):

- Effect journal committed at invocation time, not with the disposition (AC-07 was impossible).
- Durable event subscriptions with per-task mailboxes, so events arriving between activations are not lost.
- Conversation turn model (`submitTurn`, briefing at turn start); rule-based conversational agent possible.
- Human-action decisions checked against the request before task state; one expiry mechanism (`onExpiry`).
- Guard order puts idempotency replay before state checks; full refusal lists; retry policy and cancel grace period defined; execution edges for queued aborts.
- `TaskEvent` ordering by `(revision, sequence)`; `notificationCreated` event feeds the inbox; `InboxEntry` type.
- Agent v1 rev 3: `DelegateInput`, `HandlerRegistry`, instance and human-action operations, record types, richer `WakeReason`.
- POC scope: journeys reworked; AC-15…AC-20 added; requirement mappings corrected.

### Changed — design review (2026-11-04)

See [design review](docs/review/2026-11-04-design-review.md) for the 20 findings and rationale.

- Runtime contract rev 2: explicit transition tables for task, execution, instance and human action; guard ordering; durability levels; single source of truth for lifecycle.
- Agent v1 rev 2: call layering, extended `WakeupRequest` (timer, schedule, event, human action, child tasks, timeout), replay-safe step keys, `AgentService` additions, `Agent.definition` as a reference.
- Capability v1 rev 2: canonical capability catalog, durability as one guarantee with levels, operation effect classes.
- Communication v1 rev 2: outbound SPI of the TaskService with `CallContext`, route binding and remote task projection.
- Requirements rev 2: single table, testable acceptance criteria, traceability, priority fixes; added R-34…R-38.
- Domain model rewritten as entity map, ER diagram and glossary; capabilities page no longer duplicates contract tables.
- Retry rule unified across documents; task pause/resume deferred (`UnsupportedOperation` in v1).
- Roadmap restructured around a walking-skeleton M1; counts corrected.

### Added — design review (2026-11-04)

- [Errors v1](docs/contracts/errors-v1.md) catalog.
- [POC scope](docs/poc-scope.md): journeys J1/J2 and acceptance checks AC-01…AC-14.
- Proposed ADR-0016 (language/tooling), ADR-0017 (first persistence and activation), ADR-0018 (execution per activation).

### Notes

Architecture and conceptual APIs are **not an implementation or production-ready release**.
