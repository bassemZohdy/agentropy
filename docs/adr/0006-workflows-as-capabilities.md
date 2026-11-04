# ADR-0006: Workflows and schedulers are execution capabilities of agents

- Status: Accepted (design direction)
- Date: 2026-11-04

## Context

The product is modeling multi-agent collaboration rather than primarily an Agent–Workflow relationship. Deterministic workflows may still be essential for reliability and governance, and can power agents without continuous LLM calls.

## Decision

Expose an agent-to-agent delegation model to consumers and users. Agents may use workflow engines, schedulers, events, tools and LLM calls behind composable capabilities. Do not require a workflow to be represented as a distinct agent unless it has a meaningful logical agent identity/responsibility. Keep deterministic flows and governed LLM decisions complementary.

## Consequences

Temporal, Quarkus Flow, LangGraph or other providers can be integrated behind capability adapters, rather than made mandatory dependencies. Provider semantic differences must be surfaced explicitly.

## Open

Concrete engine adapter selection and whether some workflows are promoted to long-lived agent identities.
