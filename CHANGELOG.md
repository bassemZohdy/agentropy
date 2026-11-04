# Changelog

This project follows a human-readable changelog. Release versions will be introduced when implementation starts.

## Unreleased — 2026-11-04

### Added

- Initial README and documented product vision, scope, requirements and logical architecture.
- Agent domain model, capability profiles and registry/pool/runtime design.
- Multi-agent delegation, shared inbox, security and recovery guidelines.
- Nine architecture decision records (seven accepted design directions, two proposed).
- Milestone-based implementation roadmap.

- Reviewed [langgraph-flows](https://github.com/bassemZohdy/langgraph-flows) architecture and selectively adapted lifecycle, messaging, inbox, priority, authorization, human actions, versioning and testing requirements.
- Added the cross-project reuse assessment, task runtime contract, agent messaging contract, and human-action/proactive-policy documentation.
- Added ADRs 0010–0014 as proposed decisions and expanded architecture/requirements/roadmap references.
- No source code or external runtime dependency was copied.

- Finalized initial Agent v1 and Capability v1 architecture contracts covering profile resolution, agent identity, lifecycle ownership, provider guarantees, authorization, version pinning and conformance criteria.

### Notes

Architecture and conceptual APIs are **not an implementation or production-ready release**.
