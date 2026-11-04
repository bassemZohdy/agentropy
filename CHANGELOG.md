# Changelog

This project follows a human-readable changelog. Release versions will be introduced when implementation starts.

## Unreleased — 2026-11-04

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
