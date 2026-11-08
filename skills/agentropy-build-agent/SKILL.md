---
name: agentropy-build-agent
description: Build a durable agent or application on the Agentropy TypeScript framework. Use when the user wants to write an Agentropy agent handler, create a local app, define agents, delegate tasks, wait on timers, events or human approvals, give agents tools or Agent Skills, or test an Agentropy agent offline.
license: Apache-2.0
compatibility: Node.js 24 or newer and pnpm. The Agentropy packages are private to the repository (not on npm yet), so work inside a checkout or workspace that contains packages/ from https://github.com/bassemZohdy/agentropy.
metadata:
  project: agentropy
  audience: application-developers
---

# Build an agent on Agentropy

An Agentropy agent is a **handler**. It gets an invocation and returns a **disposition**. A task survives restarts because a waiting disposition stores its checkpoint and wake-up in the same transaction. Read `docs/quickstart.md` in the repository for the long form. `packages/examples/src/quickstart.ts` is the runnable version, and CI runs it.

## 1. Write the handler

```ts
import type { Agent } from '@agentropy/core';

const reminder: Agent<{ message: string; delayMs: number }> = {
  handle: async (inv) => {
    if (inv.activation === 1) {
      const at = new Date(Date.now() + inv.input.delayMs).toISOString();
      return { kind: 'waiting', wakeup: { anyOf: [{ kind: 'timer', at }] }, checkpoint: { scheduledFor: at } };
    }
    return { kind: 'completed', output: { reminder: inv.input.message } };
  },
};
```

- Dispositions are `completed`, `failed` and `waiting`. Waiting carries a wake-up condition and a checkpoint.
- Wake-ups are timers, events, child tasks, human actions and schedules. A waiting task holds no worker.
- Instants (timers, deadlines) must be ISO-8601 with a zone. Local times without a zone are rejected.
- Honor `inv.signal` (abort) in long work. `limits.maxActivationMs` (default 10 min) fences a handler that ignores it.
- Outcomes: unclassified errors and `Internal` are retried with backoff. Throw an `AgentropyError` with a specific code when a failure is final.

## 2. Create the app, instance and task

```ts
import { createLocalApp } from '@agentropy/runtime';
import { SqliteStore } from '@agentropy/store-sqlite';

const app = createLocalApp({ store: new SqliteStore({ path: './app.db' }), pdp: myPolicy });
app.define(definition('reminder'), reminder);
const instance = await app.createInstance({ definition: { id: 'reminder', version: '1.0.0' }, ownerId: 'alice', idempotencyKey: 'my-reminder' }, alice);
const task = await app.delegate({ target: { instanceId: instance.id }, input: { message: 'stand-up', delayMs: 200 }, idempotencyKey: 'reminder-1', correlationId: 'demo' }, alice);
const stop = app.start(250);              // scheduler loop: wake-ups, dispatch, outbox relay
const output = await app.getResult(task.taskId, alice);
await stop();
```

Rules that are easy to get wrong:

- **Policy is mandatory.** There is no allow-all default. Supply a `PolicyDecisionPoint`. `packages/examples/src/common.ts` has `SameTenantPolicy` and a `definition()` helper that fills defaults.
- **Callers are `TrustedPrincipal`s** that your transport has already authenticated. Never build one from request data you did not verify.
- **Every write takes an idempotency key.** Repeating a call with the same key returns the same instance or task.
- **Store choice:** `SqliteStore` for one process. `PostgresStore` when several workers share a database (it needs `pg`). `MemoryStore` loses everything on exit and is only for tests.
- **Limits:** input, output, event and prompt sizes are bounded (`RuntimeLimits`: `maxInputBytes`, `maxOutputBytes` 1 MiB, `maxEventBytes` 256 KiB, `maxPromptBytes` 16 KiB). Oversized output fails the task.
- **Side effects** need an idempotency key or reconciliation. The runtime gives at-least-once delivery, never exactly-once.

## 3. Add capabilities

| Need | Use | Read |
|---|---|---|
| Human approval | request a human action and wait on it | `docs/human-actions.md`, `pnpm example:expense-approval` |
| React to events over time | event wake-ups and subscriptions | `pnpm example:price-watch` |
| Tools (including MCP servers) | `McpToolProvider` plus the tool executor, which applies policy and audit | `docs/contracts/tool-v1.md` |
| Model calls | the `reasoning` capability, optionally `routedReasoning` for residency and data-class routing | `docs/contracts/capability-v1.md` |
| Agent Skills | `createLocalApp({ ..., skills: { registry } })` with an `InMemorySkillRegistry`, then `skills: [{ id, versionRange }]` in the definition. The handler reads `ctx.skills` | `docs/contracts/skill-v1.md` |
| Workflow engines | a `WorkflowEngine` adapter such as Conductor; `workflow.start` is journaled by step key | `docs/conformance-kit.md` |
| Remote agents | A2A, see the `agentropy-a2a` skill | `docs/contracts/communication-v1.md` |

## 4. Test offline

- Use `FakeClock` from `@agentropy/testkit` and `await app.runUntilIdle()` instead of real timers and `app.start()`.
- `blockNetwork()` from the testkit makes accidental outbound calls fail. Live suites opt in with `allowNetwork([...])`.
- Writing a new store, communication provider or workflow adapter? Run the shared suites (`defineStoreConformance`, `defineCommunicationConformance`, `defineWorkflowEngineConformance`) against it. See `docs/conformance-kit.md`.
- Test crash recovery for anything stateful: stop the app mid-task, reopen the store, and check the task resumes from its checkpoint with no duplicate side effect.

## Before calling it done

Run `pnpm check` (lint, typecheck, tests, format check, API index check). If you added or changed an exported symbol, regenerate the API index with `pnpm docs:api`.
