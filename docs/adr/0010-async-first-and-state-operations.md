# ADR-0010: Asynchronous-first delegation and explicit state operations

- Status: Accepted (2026-11-06, TASK-034.1); the optional `executeAndWait` helper is not provided
- Inspiration: [langgraph-flows ADR-0002](https://github.com/bassemZohdy/langgraph-flows/blob/main/docs/adr/ADR-0002-flow-lifecycle-and-capability-operations.md) and [ADR-0003](https://github.com/bassemZohdy/langgraph-flows/blob/main/docs/adr/ADR-0003-async-first-flow-execution-and-isolation.md).

## Context
Agentropy tasks may complete immediately or run across sessions and infrastructure restarts. Conversation agents should not implement execution state machines or wait indefinitely for results.

## Proposal
Delegation returns an accepted task handle asynchronously; the runtime is authoritative for task transitions and capability-gated operations. Queries/events provide status and results, and an optional bounded executeAndWait uses the same task path. Task and Execution records are separate; retries do not silently reopen terminal tasks. Unsupported operations return typed errors.

## Consequences
Requires a versioned transition matrix, idempotent acceptance, transport-unknown outcome resolution and provider-specific mapping. Session lifetime does not bound task lifetime.

## Alternatives
Synchronous-only task execution, per-agent arbitrary public lifecycle, implicit no-op unsupported controls.

## Evidence (2026-11-06, TASK-034.1)

- `delegate` returns a task handle after durable acceptance; the runtime alone moves tasks through the versioned transition matrix (`assertTransition`, `packages/core/src/lifecycle.ts`): `packages/runtime/test/task-service.test.ts`, `packages/runtime/test/runtime.test.ts`.
- Task and Execution records are separate; retries create new executions and never reopen terminal tasks (ADR-0018).
- Idempotent acceptance and transport-unknown resolution by re-sending the same key (TM-03).
- Not provided: a bounded `executeAndWait`. Callers combine `delegate` with `subscribe` or `getTask`; the helper can be added later without changing the task path.
