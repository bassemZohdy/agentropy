# ADR-0002: Agent roles with required/default/optional capability profiles

- Status: Accepted (design direction)
- Date: 2026-11-04

## Context

Distinct agent categories should have predictable baseline behavior without becoming rigid types.

## Decision

Provide predefined profiles for Conversational, Task, Monitoring, Coordinator and Specialist agents. Each profile contains required, default and optional capabilities. Required capabilities are non-removable; defaults can be overridden under policy; optional capabilities are opt-in. Task agents require durable task support by default; scheduling is available but not inherently required. Profiles are configuration/templates, not mandatory concrete subclasses.

## Consequences

Profiles enable consistency and specialization while permitting mixed agent behavior. The resolver must validate effective capabilities and provider guarantees, including tenant policy.

## Open

Review baseline required/default sets once real adapters are validated.
