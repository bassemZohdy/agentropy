# ADR-0011: Transport-neutral versioned agent messaging

- Status: Accepted (2026-11-06, TASK-034.1); no message-broker adapter yet
- Inspiration: [langgraph-flows ADR-0004](https://github.com/bassemZohdy/langgraph-flows/blob/main/docs/adr/ADR-0004-pluggable-flow-communication.md).

## Context
Agent delegation and user-facing status events must work across local and eventually distributed runtime topologies.

## Proposal
Use versioned command, query and event envelopes carrying message, task, agent, correlation, causation, principal and idempotency metadata. Separate trusted command authorization and task state from in-process, durable-outbox and broker transports. Enforce deduplication, replay and typed compatibility errors. Each task transition has a monotonic revision.

## Consequences
Uniform contract tests across adapters; outbox/queue selection is replaceable. Exactly-once delivery is not promised.

## Alternatives
Hardwiring to a broker or workflow engine; conversational agent managing worker internals.

## Evidence (2026-11-06, TASK-034.1)

- Versioned envelopes (`AgentMessage`, events) carry message, task, agent, correlation, causation, principal and idempotency fields and are validated (`validateAgentMessage`); the trusted principal comes from the transport.
- Transports are separate from authorization and state: in-process delivery, the durable outbox relay, and A2A JSON-RPC with SSE and push (`packages/runtime/test/outbox-inbox.test.ts`, `packages/testkit/test/a2a.test.ts`, `packages/testkit/test/a2a-streaming.test.ts`).
- Deduplication and replay: inbound event IDs and message IDs are deduplicated across restarts (`packages/testkit/test/delivery.test.ts`); every task transition bumps a monotonic revision.
- Not built: a broker adapter (Kafka, NATS and so on). Outbox relay consumers are the extension point; exactly-once delivery is not promised, as proposed.
