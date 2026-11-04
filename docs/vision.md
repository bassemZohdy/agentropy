# Vision, scope and positioning

## Product vision

Agentropy is an open-source, capability-driven framework to define, manage and coordinate multiple AI agents and autonomous task actors. It models the relationship between the user-facing conversational assistant and delegated agents directly: workflows, schedulers, tools and model calls are execution facilities behind agents, not necessarily user-visible participants.

**Positioning:** A composable multi-agent framework that enables reliable, controlled autonomous work with an optional visible agent-team experience.

## Problem

Today's conversational applications often hide all ongoing work behind one assistant, while agentic products sometimes expose every technical worker as an independent persona. Neither extreme provides a consistent mental model for delegation, persistent responsibilities, user control and safe progress reporting. Agent and workflow tooling also tends to mix logical agent identity with a runtime worker, deployment, execution or temporary job.

## Outcomes

1. A main conversational agent can delegate a bounded goal to one or more specialized agents and explain that delegation to the user.
2. A delegated agent can continue after the originating session closes and asynchronously report results.
3. Users have one primary conversation, optional visibility into agents and a durable inbox for progress, approvals and outcomes.
4. Agents gain capabilities from reusable profiles and independently configured providers, not class hierarchy or hard-coded runtime assumptions.
5. Deterministic workflows and schedulers can implement agent responsibilities without pretending every action needs an LLM.
6. A registry enables governed discovery and a pool allocates execution capacity independently of durable agent ownership.
7. Durability, permissions, audit, recovery and cancellation are enforceable contracts rather than marketing labels.

## Boundaries

**In scope:** Core model, agent definitions and instances, profiles/capabilities, delegation, task/execution lifecycle, registry/discovery, runtime/pool abstractions, shared messaging/inbox contracts, security and recovery policy, example provider adapters.

**Out of scope initially:** A proprietary end-to-end workflow engine, mandatory UI framework, built-in LLM serving, autonomous unrestricted tool access, a new wire protocol, a distributed scheduling platform before an in-process implementation is proven.

## Design maturity

The documented architecture is a proposed baseline. Initial implementation language, persistence backend, wire formats and exact adapter selection are deliberately open until proof-of-concept tests inform ADRs. Do not assume an adopted platform or production guarantee merely from a conceptual diagram.
