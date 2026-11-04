# ADR-0004: Separate agent definition, logical instance, task and execution

- Status: Accepted (design direction)
- Date: 2026-11-04

## Context

Agent identity, work assignment, execution attempt and worker process have different lifetimes. Blending them makes persistent agents, recovery and pooling difficult to model.

## Decision

Model versioned AgentDefinition, persistent AgentInstance, DelegatedTask and one-or-many Execution records separately. Tasks may spawn bounded child tasks. The same instance may own multiple tasks and wake multiple times. Worker leases and process ownership are ephemeral.

## Consequences

Durable entities need unique identifiers, versioning and well-defined state transitions. Execution updates require fencing and idempotent effect handling; completion and user notification are separate events.

## Open

Data layout, tenancy partitions and migration strategy remain implementation choices.
