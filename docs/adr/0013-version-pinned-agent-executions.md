# ADR-0013: Version-pinned tasks and provider compatibility

- Status: Proposed (2026-11-04)
- Inspiration: [langgraph-flows ADR-0009](https://github.com/bassemZohdy/langgraph-flows/blob/main/docs/adr/ADR-0009-version-pinned-flow-runs.md).

## Context
Long-running delegated tasks may survive changes to agent definitions, capability providers, workflow code, schemas and deployments.

## Proposal
Pin each accepted task to immutable agent definition/profile and effective capability contract versions, plus provider/build compatibility metadata. Validate schema migrations and durable history/replay under actual adapters. Do not replace in-flight semantics with the latest definition silently. Use safe routing, compatibility adapters or controlled draining as appropriate.

## Consequences
Implement compatibility matrices, older-version lookup, worker rollout and rollback tests. Metadata pinning alone is insufficient for Temporal or other replay-based engines.

## Alternatives
Always upgrade in-flight work on deployment, or always require a dedicated worker per historical version.
