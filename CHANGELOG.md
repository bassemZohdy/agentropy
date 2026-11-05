# Changelog

This project follows a human-readable changelog. Release versions will be introduced when implementation starts.

## [Unreleased]

### Added

- **FEAT-015** (feat): Skill registry and loader for the standard Agent Skills format (S-02, S-03, S-04). Ref: docs/contracts/skill-v1.md. Validated: `pnpm exec vitest run packages/runtime/test/skills.test.ts`. Notes: filesystem source only; remote skill distribution and script execution remain unsupported (UnsupportedOperation).
- **FEAT-014** (feat): Tool registry and executor with PEP, audit and two direct adapters (T-01, T-02, T-03, N-01). Ref: docs/contracts/tool-v1.md. Validated: `pnpm exec vitest run packages/runtime/test/tools.test.ts`. Notes: MCP/UTCP/REST adapters and plugin startup-hook checks are not implemented (no such runtime exists in M1); the negative matrix covers discovery-only, unverified activation, unauthorized activation, suspend/revoke, tenant spoofing, fresh PDP decisions, PDP outage, audit failure, pin changes, credential redaction.
- **FEAT-013** (feat): Definition registry, instance directory, discovery and native-ts implementation provider (M1-03). Ref: docs/contracts/agent-implementation-v1.md. Validated: `pnpm exec vitest run packages/runtime/test/registry.test.ts packages/runtime/test/implementation.test.ts`.
- **FEAT-012** (feat): Pure acceptance resolver: capability catalog/profiles, implementation, tools, skills (M1-02, A-03, D-01). Ref: docs/contracts/capability-v1.md#resolution-algorithm-authoritative-ordering. Validated: `pnpm exec vitest run packages/core/test/resolver.test.ts packages/core/test/acceptance.test.ts`. Docs: updated docs/contracts/agent-implementation-v1.md. Includes: FEAT-012.1, FEAT-012.2.
- **FEAT-011** (feat): Core contract package: error catalog, transition tables, types and JSON Schemas (M1-01, A-01, S-01). Ref: docs/contracts/agent-v1.md. Validated: `pnpm exec vitest run packages/core/test`. Includes: FEAT-011.1, FEAT-011.2, FEAT-011.3.

### Changed

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
