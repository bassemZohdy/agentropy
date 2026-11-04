# ADR-0017: First persistence, wake-up scheduler and event transport

- Status: Accepted (2026-11-04) — M1 single-process SQLite, polling scheduler, in-process event transport and transactional outbox
- Resolves: roadmap M0-06 (for M1 only)

## Context

M1 needs durable tasks, checkpoints, wake-ups, an effect journal, an outbox and an inbox, all updated **atomically** with lifecycle transitions (runtime contract T4 requires checkpoint + wake-up in one transaction). It must run offline in CI and on a laptop.

## Accepted M1 decision

- **Storage port** (`Store` interface with an explicit `transaction(fn)` unit of work) in `core`; **SQLite** adapter for M1 (WAL mode, single process). All lifecycle writes, wake-up registrations and outbox records for one transition happen in one SQLite transaction. **Effect-journal entries are not part of the disposition transaction**: each is committed at invocation time, together with the effect itself when the effect is platform-internal (inbox entry, child task, human action) — see [Agent v1](../contracts/agent-v1.md#idempotent-side-effects). Otherwise a crash before the disposition commits would lose the journal and repeat the effect (AC-07).
- **Scheduler:** a polling loop over the `wakeup_registrations` table (`status = armed AND due_at <= now`), driven by an injectable clock; fires via `AgentRuntime.fireWakeup`, which consumes the registration with a conditional update (exactly-once consumption, at-least-once delivery).
- **Event transport:** in-process bus for event sources. Each inbound event is recorded and appended to the mailbox of every matching **durable subscription** in one transaction; a waiting task whose `event` condition now has a pending mailbox entry is woken. Events arriving while a task runs stay in its mailbox ([runtime contract](../runtime-contract.md#event-subscriptions-no-lost-events-between-activations)).
- **Outbox relay:** in-process worker leasing unpublished outbox rows → inbox projector and subscribers.
- **Second adapter (M3):** PostgreSQL with `SELECT … FOR UPDATE SKIP LOCKED` for multi-worker leasing; the same conformance suite gates both.

## Security clarification

Mandatory audit intent for protected state-changing work must be durably committed before reporting the change as committed (same transaction or a transactionally committed outbox). A remote audit sink acknowledgment is not implied. Do not start an unauthorized effect during PDP unavailability; the pending policy-wait scheduling semantics remain a separate open contract decision. The exact SQLite library and polling interval are implementation choices, not decided here.

## Consequences

One transactional boundary makes R-08/R-29/R-34 testable in M1 without distributed infrastructure. SQLite mode is explicitly **single-process, not HA** (as already stated in operations). Store interface must avoid SQLite-only semantics so Postgres can follow.

## Alternatives

Postgres from day one (needs a container in CI); Temporal as the durable runtime (couples the core to one provider, contrary to ADR-0008); event broker (unnecessary in one process).
