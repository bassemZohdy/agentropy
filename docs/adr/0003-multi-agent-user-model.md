# ADR-0003: One primary conversational assistant, visible delegation

- Status: Accepted (design direction)
- Date: 2026-11-04

## Context

The desired UX reflects an assistant backed by specialized, often persistent agents. Exposing raw workflow calls misses the collaborative model; multiple competing agent conversations can add complexity.

## Decision

The main ConversationalAgent remains the primary contact. It may explicitly acknowledge delegation to a separately identified specialized agent and surface its status. User-facing details of agent teams are optional; specialist agents normally publish outcomes to the main assistant/user inbox instead of initiating separate chats.

## Consequences

The system needs delegation identity, task status, optional visibility, reporting and coherent communication policy. Product messaging must reflect genuine delegated execution, not falsely attribute deterministic backend activity to independent LLM personas.

## Open

Whether selected specialist agents can expose direct conversation will depend on per-agent capabilities and product policy.
