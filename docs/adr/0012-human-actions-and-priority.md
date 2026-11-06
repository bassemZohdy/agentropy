# ADR-0012: Actionable user inbox, authoritative human actions and contextual priority

- Status: Accepted (2026-11-06, TASK-034.1)
- Inspiration: [langgraph-flows ADR-0005](https://github.com/bassemZohdy/langgraph-flows/blob/main/docs/adr/ADR-0005-user-inbox-actionable-projection.md), [0006](https://github.com/bassemZohdy/langgraph-flows/blob/main/docs/adr/ADR-0006-shared-priority-and-proactive-policy.md), [0007](https://github.com/bassemZohdy/langgraph-flows/blob/main/docs/adr/ADR-0007-human-task-validation-and-idempotency.md).

## Context
Delegated agents can report completion or request actions when the user is offline. Priority is both a business obligation and a contextual user experience concern. UI/chat responses may race with expiry or reassignment.

## Proposal
Keep a user- and tenant-scoped durable inbox as a projection of authoritative task events. Human actions have stable request IDs, typed schemas, eligible assignees, deadlines and revisions; the task runtime validates final decisions atomically with idempotency and current authorization. Effective priority combines task business priority, bounded personal-context suggestions and non-downgradable policy minimums. Track delivery, read, presentation and resolution separately; the main assistant gives a bounded turn-start briefing and optional push.

## Consequences
Needs replay/reconciliation, anti-repetition presentation policies, expiry/conflict handling and strict cross-tenant authorization. No model statement substitutes for approval.

## Alternatives
Session-local inbox, UI-only approvals, agent-only priority ranking, and perpetual conversational polling.

## Evidence (2026-11-06, TASK-034.1)

- Durable, tenant- and user-scoped inbox projected from task events, with delivery, read, presentation and resolution tracked separately and a bounded turn-start briefing (`conversation.briefing`): `packages/testkit/test/inbox-policy.test.ts`, `packages/runtime/test/outbox-inbox.test.ts`.
- Human actions with stable request IDs, schemas, assignees, deadlines and revisions; decisions are validated atomically with idempotency and current authority (TM-13…TM-15, TM-32): `packages/runtime/test/human-actions.test.ts`, `packages/testkit/test/hardening.test.ts`.
- Effective priority is `max(entry severity, policy floor)`; personal preferences cannot hide an entry that has a floor (`packages/runtime/src/priority.ts`).
