# ADR-0007: Always-on denotes persistent responsibilities; use a durable shared inbox

- Status: Accepted (design direction)
- Date: 2026-11-04

## Context

Always-on agents may react to timers, events or condition changes. Keeping an LLM or process continuously active is unnecessarily expensive and may not improve reliability. User updates should remain coherent with one main assistant.

## Decision

Persist the agent's responsibility, task, subscriptions and wake-up triggers. Reactivate it on demand through the runtime/pool. Record user-relevant progress, outcomes and approvals in a durable user inbox. The conversational agent consumes relevant updates at session start or by authorized push, classifies importance and communicates with the user.

## Consequences

Requires durable activation, outbox/inbox reliability, delivery acknowledgement, prioritization and user controls. Inbox does not replace execution persistence.

## Open

Notification policies, user preferences and push vs polling transport are to be specified.
