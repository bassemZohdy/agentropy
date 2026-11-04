# ADR-0008: Provider-neutral runtime with explicit durability contracts

- Status: Proposed
- Date: 2026-11-04

## Context

We want framework neutrality without introducing a general workflow engine. Candidate providers offer different scheduling, checkpoint and event semantics.

## Proposal

Define portable interfaces for agent runtime, scheduling, workflow invocation, persistence, tool access, memory and model calls. Initial implementation should be in-process and modest; use adapters only where they deliver needed features. Enforce explicit unsupported-feature errors rather than silently changing execution semantics. Validate durability with crash/restart and idempotency tests.

## Consequences

Avoids premature lock-in but adds compatibility documentation and integration test requirements. Cross-provider state migration is not assumed.

## Open

Language/runtime, initial persistence, first workflow provider and supported portability guarantees require separate ADRs.
