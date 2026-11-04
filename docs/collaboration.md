# Multi-agent delegation, user inbox and UX

## Experience contract

The main ConversationalAgent is the user's primary relationship and communication surface. When long-running work is delegated, it can explicitly say a specialized agent is following up, show useful progress and let the user inspect, pause or cancel authorized tasks. Agents can remain distinct logical identities without opening competing conversations or implying that every workflow is an independent personality.

**Example:** "I'll assign a monitoring agent to watch for the requested change and update you when the condition is met." This statement should reflect a real registered agent/task rather than theatrical narration.

## Delegation contract

Delegation includes parent/child task ID, initiating principal, delegated agent identity, bounded goal, maximum duration, budget/resources, allowed tools, escalation rules, correlation context and idempotency key. The receiving agent accepts or rejects with a reason and subsequent state updates. A task may delegate further only if policy permits; depth, fan-out and budget are bounded.

## Shared inbox

The inbox receives durable, deduplicated progress, final results, user approvals, failures and significant events. Each entry contains user ownership, agent identity, task/execution references, type, severity/importance, timestamps, payload reference, acknowledged/delivered state and replay key. The inbox is **not** the source of truth for execution state.

The main agent fetches unread/relevant entries when a conversation begins and can also receive authorized pushes. Communication policy classifies urgent items for timely delivery and summarizes or holds non-urgent updates for context or on-demand inspection. Approval waits for authenticated user action and must not be inferred from a notification delivery.

## Independent operation

An "always-on" agent persists its responsibility, subscriptions or schedules and wakes when required. On trigger it acquires execution capacity, performs bounded work, checkpoints, reports, and returns to idle. This holds for both AI-enabled and purely workflow-backed agents. Continuous resource occupancy is not required.

## Reliability and security

Use a durable outbox/inbox delivery boundary or equivalent to avoid losing progress between state commit and publish. Handle duplicates and out-of-order updates; do not promise exactly-once external side effects. Verify recipients, authority and consent before revealing agent results. Allow delegated task cancellation with explicit state and acknowledgment even when downstream processes cannot immediately stop.

## Open questions

Agent-to-agent wire protocol, remote/distributed collaboration, UX identity/branding, notification ranking, and the degree of direct specialist-agent conversation are future ADR topics. The agreed default is **one primary assistant, visible delegation when helpful, optional agent detail**.
