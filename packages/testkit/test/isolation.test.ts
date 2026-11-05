// FEAT-022.4: AC-14 — two app contexts in one process do not see each other's agents or tasks, and the whole
// suite runs with the network disabled (vitest.setup.ts installs the guard for every test file).
import type { Agent } from '@agentropy/core';
import net from 'node:net';
import { describe, expect, it } from 'vitest';
import { NetworkDisabledError, isNetworkBlocked } from '../src/index.js';
import { alice, code, completes, harness } from '../../runtime/test/harness.js';

describe('AC-14: app-context isolation', () => {
  it('two contexts in one process keep separate definitions, instances, tasks, idempotency and inboxes', async () => {
    // Each context owns its store, registries, runtime and services; nothing is process-global.
    const a = harness({ builtin: true });
    const b = harness({ builtin: true });
    a.define('only-in-a', completes('a'));
    b.define('only-in-b', completes('b'));
    const notifier: Agent = {
      handle: async (_i, ctx) => {
        await ctx.capabilities.invoke(
          'notification',
          'notify',
          { severity: 'low', title: 'from a', body: 'b' },
          { stepKey: 'n' },
        );
        return { kind: 'completed', output: null };
      },
    };
    a.define('notifier', notifier);

    const ia = await a.instance('only-in-a');
    const ta = await a.delegate(ia.id, {}, 'same-key');
    await a.delegate((await a.instance('notifier')).id, {}, 'n');
    const tb = await b.delegate(
      (await b.instance('only-in-b')).id,
      {},
      'same-key',
    );
    await a.runtime.runUntilIdle();
    await b.runtime.runUntilIdle();

    expect(ta.taskId).not.toBe(tb.taskId);
    expect(await a.tasks.getResult(ta.taskId, alice)).toBe('a');
    expect(await b.tasks.getResult(tb.taskId, alice)).toBe('b');
    expect(await code(b.tasks.getTask(ta.taskId, alice))).toBe('NotFound');
    expect(await code(a.tasks.getTask(tb.taskId, alice))).toBe('NotFound');
    expect(await code(b.instances.get(ia.id, alice))).toBe('NotFound');
    expect(
      b.definitions.get({ id: 'only-in-a', version: '1.0.0' }),
    ).toBeUndefined();
    expect(b.definitions.versions('only-in-a')).toEqual([]);
    expect(await code(b.delegate(ia.id, {}, 'cross'))).toBe('NotFound');
    expect((await a.inbox.list({}, alice)).entries).toHaveLength(1);
    expect((await b.inbox.list({}, alice)).entries).toHaveLength(0);
  });

  it('the network is disabled for the whole suite: TCP, DNS and fetch fail before leaving the process', async () => {
    expect(isNetworkBlocked()).toBe(true);
    await expect(fetch('https://example.com')).rejects.toBeInstanceOf(
      NetworkDisabledError,
    );
    expect(() => net.connect(443, 'example.com')).toThrow(NetworkDisabledError);
    const dns = await import('node:dns');
    await expect(dns.promises.lookup('example.com')).rejects.toBeInstanceOf(
      NetworkDisabledError,
    );
  });
});
