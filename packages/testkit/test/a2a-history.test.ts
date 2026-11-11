// FEAT-044.2: A2A 1.0 message history. With `history: { store }` the endpoint keeps the user messages it accepted for a
// task, and `historyLength` (on `GetTask`, `ListTasks` and `SendMessage` configuration) limits how many of the most
// recent ones come back. Without the option nothing is kept and `historyLength` has no effect. History is recorded
// per sending principal, bounded per task, and removed by compaction with the task.
import {
  BUILTIN_PROFILES,
  type AgentDefinition,
  type TrustedPrincipal,
} from '@agentropy/core';
import { describe, expect, it } from 'vitest';
import {
  createA2AHistory,
  createA2AServer,
  createLocalApp,
  localAppTarget,
  type A2AServer,
} from '../../runtime/src/index.js';
import { sqliteTempStore } from '../../runtime/test/harness.js';
import { FakeClock, FakePolicy } from '../src/index.js';

const caller: TrustedPrincipal = {
  id: 'svc-a',
  type: 'service',
  tenantId: 't-1',
};
const bob: TrustedPrincipal = { id: 'bob', type: 'user', tenantId: 't-1' };
const ops: TrustedPrincipal = { id: 'ops', type: 'service', tenantId: 't-1' };

const asker: AgentDefinition = {
  id: 'asker',
  version: '1.0.0',
  displayName: 'asker',
  profile: { id: 'task', version: '1.0.0' },
  implementation: {
    providerId: 'native-ts',
    providerVersion: '1.0.0',
    artifact: { id: 'asker', version: '1.0.0' },
  },
  inputSchema: true,
  runtimeRequirements: { guarantees: [] },
  policyRef: { id: 'default', version: '1.0.0' },
  capabilities: [{ id: 'human-input', versionRange: '^1.0.0' }],
};

async function peer(history: boolean | { maxMessages: number } = true) {
  const clock = new FakeClock('2026-11-06T00:00:00.000Z');
  const store = sqliteTempStore();
  const app = createLocalApp({
    store,
    pdp: new FakePolicy(),
    now: clock.iso,
    profiles: BUILTIN_PROFILES,
  });
  // Asks its caller a question (INPUT_REQUIRED), then completes with what it was told.
  app.define(asker, {
    handle: async (inv, ctx) => {
      if (inv.activation > 1)
        return { kind: 'completed', output: { told: inv.wakeReason } };
      const { requestId } = await ctx.capabilities.invoke<
        unknown,
        { requestId: string }
      >(
        'human-input',
        'requestAction',
        {
          kind: 'text',
          prompt: 'Which colour?',
          inputSchema: { type: 'string' },
          assignees: { principalIds: [caller.id] },
          onExpiry: 'fail-task',
        },
        { stepKey: 'ask' },
      );
      return {
        kind: 'waiting',
        wakeup: { anyOf: [{ kind: 'human-action', requestId }] },
        checkpoint: { requestId },
      };
    },
  });
  const inst = await app.createInstance(
    {
      definition: { id: 'asker', version: '1.0.0' },
      ownerId: 'bob',
      idempotencyKey: 'asker',
    },
    bob,
  );
  const server = createA2AServer(localAppTarget(app), {
    instanceId: inst.id,
    ...(history
      ? {
          history: history === true ? { store } : { store, ...history },
        }
      : {}),
  });
  return { app, store, server, clock };
}

const rpc = async (
  server: A2AServer,
  method: string,
  params: Record<string, unknown>,
  who: TrustedPrincipal = caller,
) => (await server.handle({ jsonrpc: '2.0', id: 1, method, params }, who)).body;

const msg = (
  messageId: string,
  text: string,
  extra: Record<string, unknown> = {},
) => ({
  message: {
    role: 'ROLE_USER',
    messageId,
    parts: [{ text }],
    ...extra,
  },
});

type Task = {
  id: string;
  history?: { messageId: string; parts: { text?: string }[] }[];
};
const ids = (t: Task) => (t.history ?? []).map((m) => m.messageId);

async function started(p: Awaited<ReturnType<typeof peer>>) {
  const r = await rpc(
    p.server,
    'SendMessage',
    msg('m-1', 'start', { contextId: 'ctx-1' }),
  );
  const taskId = (r.result as { task: Task }).task.id;
  await p.app.runUntilIdle();
  return taskId;
}

const getTask = async (
  p: Awaited<ReturnType<typeof peer>>,
  id: string,
  historyLength?: unknown,
  who: TrustedPrincipal = caller,
) =>
  (await rpc(
    p.server,
    'GetTask',
    { id, ...(historyLength === undefined ? {} : { historyLength }) },
    who,
  )) as {
    result?: Task;
    error?: { code: number };
  };

describe('A2A message history (FEAT-044.2)', () => {
  it('keeps nothing and ignores historyLength unless history is configured', async () => {
    const p = await peer(false);
    const id = await started(p);
    const t = await getTask(p, id, 10);
    expect(t.result?.history).toBeUndefined();
  });

  it('returns the accepted messages in order; historyLength keeps the most recent, 0 keeps none, unset keeps all', async () => {
    const p = await peer();
    const id = await started(p);
    const sent = await rpc(
      p.server,
      'SendMessage',
      msg('m-2', 'blue', { taskId: id }),
    );
    expect(sent.error).toBeUndefined();
    await p.app.runUntilIdle();
    expect(ids((await getTask(p, id)).result!)).toEqual(['m-1', 'm-2']);
    expect(ids((await getTask(p, id, 10)).result!)).toEqual(['m-1', 'm-2']);
    expect(ids((await getTask(p, id, 1)).result!)).toEqual(['m-2']);
    expect((await getTask(p, id, 0)).result!.history).toBeUndefined();
    const first = (await getTask(p, id)).result!.history![0]!;
    expect(first).toMatchObject({
      role: 'ROLE_USER',
      messageId: 'm-1',
      contextId: 'ctx-1',
      taskId: id,
      parts: [{ text: 'start' }],
    });
  });

  it('SendMessage configuration.historyLength limits the history of the task it returns', async () => {
    const p = await peer();
    const r = await rpc(p.server, 'SendMessage', {
      ...msg('m-1', 'start'),
      configuration: { historyLength: 1 },
    });
    expect(ids((r.result as { task: Task }).task)).toEqual(['m-1']);
    const none = await rpc(p.server, 'SendMessage', {
      ...msg('m-9', 'again'),
      configuration: { historyLength: 0 },
    });
    expect((none.result as { task: Task }).task.history).toBeUndefined();
  });

  it('ListTasks honors historyLength per task', async () => {
    const p = await peer();
    await started(p);
    const list = async (historyLength?: unknown) =>
      (
        (
          await rpc(
            p.server,
            'ListTasks',
            historyLength === undefined ? {} : { historyLength },
          )
        ).result as { tasks: Task[] }
      ).tasks;
    expect(ids((await list(5))[0]!)).toEqual(['m-1']);
    expect((await list(0))[0]!.history).toBeUndefined();
  });

  it('a replayed message ID is recorded once', async () => {
    const p = await peer();
    const id = await started(p);
    await rpc(
      p.server,
      'SendMessage',
      msg('m-1', 'start', { contextId: 'ctx-1' }),
    );
    expect(ids((await getTask(p, id)).result!)).toEqual(['m-1']);
  });

  it('is recorded per sender: the task owner, who sent nothing, sees no history', async () => {
    const p = await peer();
    const id = await started(p);
    expect(ids((await getTask(p, id)).result!)).toEqual(['m-1']);
    const asOwner = await getTask(p, id, 10, bob);
    expect(asOwner.error).toBeUndefined();
    expect(asOwner.result!.history).toBeUndefined();
  });

  it('rejects a historyLength that is not a non-negative integer', async () => {
    const p = await peer();
    const id = await started(p);
    for (const bad of [-1, 1.5, '2', null])
      expect((await getTask(p, id, bad)).error?.code).toBe(-32602);
  });

  it('keeps only the newest maxMessages per principal and task', async () => {
    const store = sqliteTempStore();
    const h = createA2AHistory({ store, maxMessages: 2 });
    for (const n of [1, 2, 3])
      await h.record(caller, 'task-1', {
        role: 'ROLE_USER',
        messageId: `m-${n}`,
        parts: [{ text: `t${n}` }],
      });
    expect(
      (await h.read(caller, 'task-1', undefined)).map((m) => m.messageId),
    ).toEqual(['m-2', 'm-3']);
    expect((await h.read(caller, 'task-1', 1)).map((m) => m.messageId)).toEqual(
      ['m-3'],
    );
    expect(await h.read(bob, 'task-1', undefined)).toEqual([]);
  });

  it('compaction removes the history of ended tasks with the task', async () => {
    const p = await peer();
    const id = await started(p);
    await rpc(p.server, 'SendMessage', msg('m-2', 'blue', { taskId: id }));
    await p.app.runUntilIdle();
    const rows = async () =>
      (await p.store.transaction((tx) => tx.find('a2aHistory', {}))).length;
    expect(await rows()).toBe(2);
    p.clock.advanceBy(60_000);
    const result = await p.app.compact(1_000, ops);
    expect(result).toMatchObject({ a2aHistory: 2 });
    expect(await rows()).toBe(0);
  });
});
