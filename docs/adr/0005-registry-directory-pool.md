# ADR-0005: Separate definition registry, instance directory, pool and runtime

- Status: Accepted (design direction)
- Date: 2026-11-04

## Context

Discovery of agents differs from tracking logical agent instances and from allocating worker capacity.

## Decision

Model a Definition Registry for registered versions/capabilities, an Instance Directory for persistent agents, an Execution Pool for capacity and leases, and an Agent Runtime for lifecycle/execution. These are conceptual boundaries and may initially share one deployment and storage. Do not require always-on agents to occupy permanent pool slots.

## Consequences

Supports controlled discovery, multi-tenancy, elastic execution and persistence across process restarts. Distributed pool and remote discovery are postponed until needed.

## Open

Atomic capacity leasing, cross-runtime federation and distributed placement need later validation.
