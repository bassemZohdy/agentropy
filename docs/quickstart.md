# Quickstart

**Status:** FEAT-028.10 (2026-11-06). Every step below is in [`packages/examples/src/quickstart.ts`](../packages/examples/src/quickstart.ts), which CI runs on every push. Requirements are in the [compatibility matrix](compatibility.md); every symbol is listed in the [API reference](api.md).

## 1. Install and run

```sh
pnpm install
pnpm example:quickstart
```

It prints `{ "status": "completed", "output": { "reminder": "stand-up in 5 minutes", … } }`.

## 2. Write an agent

An agent is a handler. It receives an invocation (input, activation number, checkpoint, why it woke) and returns a disposition: `completed`, `failed`, or `waiting` with a wake-up condition and a checkpoint.

```ts
const reminder: Agent<{ message: string; delayMs: number }> = {
  handle: async (inv) => {
    if (inv.activation === 1) {
      const at = new Date(Date.now() + inv.input.delayMs).toISOString();
      return { kind: 'waiting', wakeup: { anyOf: [{ kind: 'timer', at }] }, checkpoint: { scheduledFor: at } };
    }
    return { kind: 'completed', output: { reminder: inv.input.message, ...(inv.checkpoint as object) } };
  },
};
```

While it waits, no worker is held; the checkpoint and wake-up are stored in the same transaction ([runtime contract](runtime-contract.md), T4). Other wake-ups: events, child tasks, human actions, schedules.

## 3. Create the app

```ts
const app = createLocalApp({ store: new SqliteStore({ path: './app.db' }), pdp: myPolicy });
app.define(definition('reminder'), reminder);
```

- **Store:** `SqliteStore` (one process) or `PostgresStore` (several workers, [ADR-0028](adr/0028-postgresql-store-adapter.md)).
- **Policy:** every call is checked by your `PolicyDecisionPoint`; there is no allow-all default. The example's `SameTenantPolicy` allows calls inside the caller's tenant.
- **Definition:** a versioned blueprint (`id`, `version`, profile, implementation binding, capabilities); `definition()` in `common.ts` fills the defaults.

## 4. Create an instance and delegate

```ts
const instance = await app.createInstance({ definition: { id: 'reminder', version: '1.0.0' }, ownerId: 'alice', idempotencyKey: 'my-reminder' }, alice);
const task = await app.delegate({ target: { instanceId: instance.id }, input: { message: '…', delayMs: 200 }, idempotencyKey: 'reminder-1', correlationId: 'quickstart' }, alice);
```

Callers are `TrustedPrincipal`s your transport has authenticated. Repeating a call with the same idempotency key returns the same task.

## 5. Run and read the result

```ts
const stop = app.start(250);          // scheduler loop: wake-ups, dispatch, relay
// … later
const snapshot = await app.getTask(task.taskId, alice);
const output = await app.getResult(task.taskId, alice);
await stop();
```

Tests and scripts can use `await app.runUntilIdle()` with a fake clock instead.

## Where next

| To | Read |
|---|---|
| Ask a human to approve something | [human actions](human-actions.md), example `pnpm example:expense-approval` |
| React to events over a long time | example `pnpm example:price-watch` |
| Call tools and models | [Tool v1](contracts/tool-v1.md), [Capability v1](contracts/capability-v1.md) (`reasoning`) |
| Delegate to agents in other runtimes | [Communication v1](contracts/communication-v1.md) (A2A, federation) |
| Run several workers, upgrade safely | [runtime contract](runtime-contract.md), [ADR-0029](adr/0029-upgrades-and-version-migration.md) |
| Deploy | [self-hosting guide](deployment.md), [SLOs](slo.md) |
| Secure it | [Security v1](contracts/security-v1.md), [threat model](security/threat-model.md) |
