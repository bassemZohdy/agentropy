# ADR-0018: One execution per activation; long-lived responsibilities as cycling tasks

- Status: Accepted (2026-11-06, TASK-034.1)
- Supersedes: execution states `checkpointed/waiting -> resumed` in runtime contract revision 1

## Context

Revision 1 documents disagreed on whether an Execution survives a wait (execution states `checkpointed/waiting/resumed`) or ends when a handler yields (Agent v1 `trigger: "resume"`, lease released on `waiting`). They also never said how a monitoring agent's standing duty is modelled: one long task, a task per trigger, or a separate "responsibility" entity.

## Decision

1. **An Execution is one activation** of the handler and always reaches a terminal state (`succeeded`, `yielded`, `failed`, `aborted`, `lost`). Initial start, each wake-up and each retry create a new Execution with `activation`/`attempt` counters.
2. **Waiting belongs to the task**, carried by a checkpoint and durable wake-up registrations. No execution or lease exists while a task waits.
3. **A standing responsibility is a non-terminal task** that cycles `waiting → assigned → running → waiting` indefinitely, ending by completion, cancellation or failure. No separate Responsibility entity in v1.
4. Execution history for long-lived tasks is **compacted**: keep the last N executions and aggregate counters; only the latest checkpoint is required.

## Consequences

Lease fencing becomes simple (an epoch per execution); crash recovery never has to resume a half-suspended execution; handler code is naturally replay-oriented. Cost: handlers must put everything they need into the checkpoint, and a monitoring task's audit trail is per-activation. Checkpoint size limits and codec rules become part of the provider conformance suite.

## Alternatives

- **Suspendable executions** (rev 1 wording): closer to workflow engines, but mixes physical attempt with logical wait and complicates fencing.
- **New task per trigger** for monitoring: easy auditing but loses the single cancellable responsibility the user was promised ("I'll watch this for you").
- **Separate Responsibility entity** creating tasks: more expressive; reconsider if M2 shows recurring patterns that don't fit (Q-03).

## Evidence (2026-11-06, TASK-034.1)

- An Execution is one activation that always ends (`succeeded`, `yielded`, `failed`, `aborted`, `lost`; `packages/core/src/lifecycle.ts`); a wake-up or retry creates a new one with `activation`/`attempt` counters: `packages/runtime/test/runtime.test.ts`, `packages/runtime/test/wakeups.test.ts`.
- Waiting belongs to the task (checkpoint plus durable wake-up registrations); no lease exists while it waits, and lease epochs fence late results (TM-38).
- Standing duties are cycling tasks (the J1 price watch journey, `packages/testkit/test/journeys.test.ts`); execution history is compacted to `keepExecutions` (`packages/testkit/test/recovery.test.ts`).
- Q-03 (a separate Responsibility entity) has not been needed so far.
