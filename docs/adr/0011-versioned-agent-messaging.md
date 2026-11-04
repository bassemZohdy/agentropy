# ADR-0011: Transport-neutral versioned agent messaging

- Status: Proposed (2026-11-04)
- Inspiration: [langgraph-flows ADR-0004](https://github.com/bassemZohdy/langgraph-flows/blob/main/docs/adr/ADR-0004-pluggable-flow-communication.md).

## Context
Agent delegation and user-facing status events must work across local and eventually distributed runtime topologies.

## Proposal
Use versioned command, query and event envelopes carrying message, task, agent, correlation, causation, principal and idempotency metadata. Separate trusted command authorization and task state from in-process, durable-outbox and broker transports. Enforce deduplication, replay and typed compatibility errors. Each task transition has a monotonic revision.

## Consequences
Uniform contract tests across adapters; outbox/queue selection is replaceable. Exactly-once delivery is not promised.

## Alternatives
Hardwiring to a broker or workflow engine; conversational agent managing worker internals.
