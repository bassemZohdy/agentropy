# ADR-0001: Capability composition over class inheritance

- Status: Accepted (design direction)
- Date: 2026-11-04

## Context

Conversational, Task and Monitoring agents may share capabilities. Rigid subtype trees require combinatorial inheritance when a MonitoringAgent also supports conversation, schedules and delegation.

## Decision

Define a small Agent contract and compose agent behavior from independently described capability contracts and provider bindings. Use dependency injection/registration, not broad subclass inheritance, to add behavior. Keep capability dependency and compatibility validation explicit.

## Consequences

Agent profiles are reusable without inheriting implementation assumptions. Capability resolution and compatibility validation become fundamental runtime responsibilities. Strong guarantees such as durability must be proved by providers, not implied by labels.

## Open

The initial API shape, provider binding and compatibility rules are now specified in [Agent Contract v1](../contracts/agent-v1.md) and [Capability Contract v1](../contracts/capability-v1.md). Implementation and conformance validation remain outstanding.
