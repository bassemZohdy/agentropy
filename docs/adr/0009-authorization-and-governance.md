# ADR-0009: Governed agent delegation and auditable authority

- Status: Proposed
- Date: 2026-11-04

## Context

Agents can delegate work and invoke tools independently of the user's active session; identity, authority boundaries and policy are critical.

## Proposal

Apply least-privilege authorization to agent discovery, task assignment, tool execution, subscriptions, and inbox reads. Carry initiating principal, agent identity and task chain in an auditable context. Prefer bounded delegation over ungoverned impersonation. Enforce quotas, depth/fan-out limits, approvals and budget ceilings. Store sensitive credentials separately from task state.

## Consequences

Delegation is a policy decision, not merely a function call. Security becomes a core platform concern even if provided by pluggable identity adapters.

## Open

Identity provider flows, token lifetimes/refresh, scope enforcement and cross-boundary trust mechanisms need threat modeling and decisions.
