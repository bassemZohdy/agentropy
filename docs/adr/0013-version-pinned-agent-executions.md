# ADR-0013: Version-pinned tasks and provider compatibility

- Status: Accepted (2026-11-06, TASK-034.1); pinning, audited migration, rollback and retirement implemented for the native runtime by [ADR-0029](0029-upgrades-and-version-migration.md); replay-based engines (Temporal, D-09) are not covered
- Inspiration: [langgraph-flows ADR-0009](https://github.com/bassemZohdy/langgraph-flows/blob/main/docs/adr/ADR-0009-version-pinned-flow-runs.md).

## Context
Long-running delegated tasks may survive changes to agent definitions, capability providers, workflow code, schemas and deployments.

## Proposal
Pin each accepted task to immutable agent definition/profile and effective capability contract versions, plus provider/build compatibility metadata. Validate schema migrations and durable history/replay under actual adapters. Do not replace in-flight semantics with the latest definition silently. Use safe routing, compatibility adapters or controlled draining as appropriate.

## Consequences
Implement compatibility matrices, older-version lookup, worker rollout and rollback tests. Metadata pinning alone is insufficient for Temporal or other replay-based engines.

## Alternatives
Always upgrade in-flight work on deployment, or always require a dedicated worker per historical version.

## Evidence (2026-11-06, TASK-034.1)

- Accepted tasks are pinned to their definition, profile, capability contracts and provider metadata in the acceptance snapshot; instances migrate versions only through audited operations with rollback: `packages/testkit/test/upgrades.test.ts`.
- Checkpoint codecs handle changed checkpoint shapes; the store refuses a schema newer than the adapter (ADR-0029, TM-41).
- Not covered: replay-based engines, where metadata pinning is not enough; they wait on D-09.
