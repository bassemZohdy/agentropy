# ADR-0008: Provider-neutral runtime with explicit durability contracts

- Status: Accepted (2026-11-06, TASK-034.1); memory has a capability contract but no provider yet
- Date: 2026-11-04

## Context

We want framework neutrality without introducing a general workflow engine. Candidate providers offer different scheduling, checkpoint and event semantics.

## Proposal

Define portable interfaces for agent runtime, scheduling, workflow invocation, persistence, tool access, memory and model calls. Initial implementation should be in-process and modest; use adapters only where they deliver needed features. Enforce explicit unsupported-feature errors rather than silently changing execution semantics. Validate durability with crash/restart and idempotency tests.

## Consequences

Avoids premature lock-in but adds compatibility documentation and integration test requirements. Cross-provider state migration is not assumed.

## Open

Language/runtime, initial persistence, first workflow provider and supported portability guarantees require separate ADRs.

## Evidence (2026-11-06, TASK-034.1)

- Portable SPIs exist and have more than one implementation: `Store` (SQLite, PostgreSQL), agent implementation providers (native TypeScript, Conductor workflows, model-backed agents), communication providers (internal, A2A), capability providers; see `packages/core/src`.
- Requested guarantees are resolved at acceptance; a runtime that cannot honour one refuses the task instead of degrading it (`packages/runtime/test/task-service.test.ts`, `packages/testkit/test/delivery.test.ts`).
- Durability is tested by crash and restart: `packages/testkit/test/recovery.test.ts`, `packages/testkit/test/postgres-runtime.test.ts`; the [conformance kit](../conformance-kit.md) packages these checks for other providers.
- Not proven: memory is a catalog behaviour contract with no provider; cross-provider state migration remains out of scope, as proposed.
