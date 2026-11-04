# Multi-agent delegation, user inbox and UX

## Experience contract

The main ConversationalAgent is the user's primary relationship and communication surface. When long-running work is delegated, it can explicitly say a specialized agent is following up, show useful progress and let the user inspect or cancel authorized tasks and suspend agents they own. Agents can remain distinct logical identities without opening competing conversations or implying that every workflow is an independent personality.

**Example:** "I'll assign a monitoring agent to watch for the requested change and update you when the condition is met." This statement should reflect a real registered agent/task rather than theatrical narration.

## Delegation contract

Delegation includes parent/child task ID, initiating principal, delegated agent identity, bounded goal, maximum duration, budget/resources, allowed tools, escalation rules, correlation context and idempotency key. The receiving agent accepts or rejects with a reason and subsequent state updates. A task may delegate further only if policy permits; depth, fan-out and budget are bounded.

## Shared inbox

The inbox receives durable, deduplicated progress, final results, user approvals, failures and significant events. Each entry contains user ownership, agent identity, task/execution references, type, severity/importance, timestamps, payload reference, acknowledged/delivered state and replay key. The inbox is **not** the source of truth for execution state.

The main agent fetches unread/relevant entries when a conversation begins and can also receive authorized pushes. Communication policy classifies urgent items for timely delivery and summarizes or holds non-urgent updates for context or on-demand inspection. Approval waits for authenticated user action and must not be inferred from a notification delivery.

## Independent operation

An "always-on" agent persists its responsibility, subscriptions or schedules and wakes when required. On trigger it acquires execution capacity, performs bounded work, checkpoints, reports, and returns to idle. This holds for both AI-enabled and purely workflow-backed agents. Continuous resource occupancy is not required.

## Proactive priority and human actions

Agent/task business priority, deadline, conversational personal relevance and organizational minimums jointly determine **effective priority** through a deterministic policy resolver. An LLM may suggest a justified personal adjustment, but cannot lower mandatory priority floors, authorize approvals or bypass user preferences and safety obligations.

At the beginning of each conversational turn, use a bounded authorized inbox snapshot: raise critical/blocking work immediately, mention normal work selectively and leave low-priority items on demand. Track a presentation revision so unchanged items are not repeatedly announced, while changes in urgency or request revision can trigger another update. Optional push updates are complementary to durable replay.

Human actions require an exact pending request ID, typed answer, assignee/role authorization, expiry and atomic runtime validation. A resolved inbox tile does not constitute approval. See [human actions](human-actions.md).

## Reliability and security

Use a durable outbox/inbox delivery boundary or equivalent to avoid losing progress between state commit and publish. Handle duplicates and out-of-order updates; do not promise exactly-once external side effects. Verify recipients, authority and consent before revealing agent results. Allow delegated task cancellation with explicit state and acknowledgment even when downstream processes cannot immediately stop.

## Open questions

Agent-to-agent wire protocol, remote/distributed collaboration, UX identity/branding, notification ranking, and the degree of direct specialist-agent conversation are future ADR topics. The agreed default is **one primary assistant, visible delegation when helpful, optional agent detail**.
