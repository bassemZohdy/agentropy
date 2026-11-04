# ADR-0017: First persistence, wake-up scheduler and event transport

- Status: Proposed (2026-11-04)
- Resolves: roadmap M0-06 (for M1 only)

## Context

M1 needs durable tasks, checkpoints, wake-ups, an effect journal, an outbox and an inbox, all updated **atomically** with lifecycle transitions (runtime contract T4 requires checkpoint + wake-up in one transaction). It must run offline in CI and on a laptop.

## Proposal

- **Storage port** (`Store` interface with an explicit `transaction(fn)` unit of work) in `core`; **SQLite** adapter for M1 (WAL mode, single process). All lifecycle writes, wake-up registrations, effect-journal entries and outbox records for one transition happen in one SQLite transaction.
- **Scheduler:** a polling loop over the `wakeup_registrations` table (`status = armed AND due_at <= now`), driven by an injectable clock; fires via `AgentRuntime.fireWakeup`, which consumes the registration with a conditional update (exactly-once consumption, at-least-once delivery).
- **Event transport:** in-process bus for event sources; inbound events are first recorded, then matched to armed `event` registrations in a transaction.
- **Outbox relay:** in-process worker leasing unpublished outbox rows → inbox projector and subscribers.
- **Second adapter (M3):** PostgreSQL with `SELECT … FOR UPDATE SKIP LOCKED` for multi-worker leasing; the same conformance suite gates both.

## Consequences

One transactional boundary makes R-08/R-29/R-34 testable in M1 without distributed infrastructure. SQLite mode is explicitly **single-process, not HA** (as already stated in operations). Store interface must avoid SQLite-only semantics so Postgres can follow.

## Alternatives

Postgres from day one (needs a container in CI); Temporal as the durable runtime (couples the core to one provider, contrary to ADR-0008); event broker (unnecessary in one process).
