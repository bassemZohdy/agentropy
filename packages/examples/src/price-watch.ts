/**
 * J1 — Price watch, with no model provider anywhere (docs/poc-scope.md#journeys, AC-01, AC-02).
 *
 * 1. The user's rule-based conversational agent receives "Tell me when ACME drops below 100." and delegates a
 *    watch to the user's monitoring agent (step key `watch:ACME:100`), replying straight away.
 * 2. The monitoring agent subscribes to `price` events for ACME and waits.
 * 3. Prices 120, 105 and 99 are published back to back; the mailbox buffers them and each activation consumes
 *    the oldest. At 99 the agent notifies the user (step key `crossed:100`) and completes.
 * 4. The user's next turn is briefed with exactly one entry, which the reply repeats.
 *
 * Run: `pnpm example:price-watch`
 */
import type { Agent, InboxEntry } from '@agentropy/core';
import { createLocalApp } from '@agentropy/runtime';
import {
  SameTenantPolicy,
  definition,
  isMain,
  tempStore,
  user,
} from './common.js';

export interface PriceWatchResult {
  replies: string[];
  /** Price seen by each monitoring activation that was woken by an event, in order. */
  activations: number[];
  monitorTaskId: string;
  monitorStatus: string;
  notifications: InboxEntry[];
}

const WATCH = /tell me when (\w+) drops below (\d+)/i;

export async function runPriceWatch(
  options: { log?: (line: string) => void; storePath?: string } = {},
): Promise<PriceWatchResult> {
  const log = options.log ?? (() => {});
  const app = createLocalApp({
    store: tempStore('price-watch', options.storePath),
    pdp: new SameTenantPolicy(),
  });
  const alice = user('alice');
  const activations: number[] = [];
  let monitorInstanceId = '';

  const assistant: Agent<{ sessionId: string; text: string }> = {
    handle: async (inv, ctx) => {
      const { entries } = await ctx.capabilities.invoke<
        unknown,
        { entries: InboxEntry[] }
      >('conversation', 'briefing', { sessionId: inv.input.sessionId });
      const watch = WATCH.exec(inv.input.text);
      if (watch) {
        const [, symbol, below] = watch;
        await ctx.capabilities.invoke(
          'delegation',
          'delegate',
          {
            target: { instanceId: monitorInstanceId },
            input: { symbol: symbol!.toUpperCase(), below: Number(below) },
          },
          { stepKey: `watch:${symbol!.toUpperCase()}:${below}` },
        );
        return {
          kind: 'completed',
          output: {
            reply: `A monitoring agent is watching ${symbol!.toUpperCase()} for you.`,
          },
        };
      }
      return {
        kind: 'completed',
        output: {
          reply: entries.length
            ? entries.map((e) => e.title).join('\n')
            : 'Nothing new.',
        },
      };
    },
  };

  const monitor: Agent<{ symbol: string; below: number }> = {
    handle: async (inv, ctx) => {
      const sub =
        (inv.checkpoint as { sub?: string } | undefined)?.sub ??
        (
          await ctx.capabilities.invoke<unknown, { subscription: string }>(
            'event-handling',
            'subscribe',
            { source: 'price', filter: { symbol: inv.input.symbol } },
            { stepKey: 'sub' },
          )
        ).subscription;
      const reason = inv.wakeReason;
      if (reason?.kind === 'event') {
        const { price } = reason.payload as { price: number };
        activations.push(price);
        if (price < inv.input.below) {
          await ctx.capabilities.invoke(
            'notification',
            'notify',
            {
              severity: 'high',
              title: `${inv.input.symbol} is at ${price} (below ${inv.input.below})`,
              body: `Price alert for ${inv.input.symbol}`,
            },
            { stepKey: `crossed:${inv.input.below}` },
          );
          return { kind: 'completed', output: { price } };
        }
      }
      return {
        kind: 'waiting',
        wakeup: { anyOf: [{ kind: 'event', subscription: sub }] },
        checkpoint: { sub },
      };
    },
  };

  app.define(
    definition('assistant', {
      displayName: 'Personal assistant (rule-based)',
      profile: { id: 'conversational', version: '1.0.0' },
    }),
    assistant,
  );
  app.define(
    definition('price-monitor', {
      displayName: 'Price monitor',
      profile: { id: 'monitoring', version: '1.0.0' },
    }),
    monitor,
  );
  const assistantInstance = await app.createInstance(
    {
      definition: { id: 'assistant', version: '1.0.0' },
      ownerId: alice.id,
      idempotencyKey: 'assistant',
    },
    alice,
  );
  monitorInstanceId = (
    await app.createInstance(
      {
        definition: { id: 'price-monitor', version: '1.0.0' },
        ownerId: alice.id,
        idempotencyKey: 'monitor',
      },
      alice,
    )
  ).id;

  const replies: string[] = [];
  const turn = async (text: string, key: string) => {
    log(`user> ${text}`);
    const handle = await app.submitTurn(
      {
        instanceId: assistantInstance.id,
        sessionId: 'session-1',
        text,
        idempotencyKey: key,
      },
      alice,
    );
    await app.runUntilIdle();
    const { reply } = await app.getResult<{ reply: string }>(
      handle.taskId,
      alice,
    );
    log(`assistant> ${reply}`);
    replies.push(reply);
  };

  await turn('Tell me when ACME drops below 100.', 'turn-1');
  const [monitorTask] = await app.store.transaction((tx) =>
    tx.find<{ taskId: string }>('tasks', {
      where: { instanceId: monitorInstanceId },
    }),
  );
  // Back to back, without waiting for the monitor to go idle between events.
  for (const [i, price] of [120, 105, 99].entries()) {
    log(`feed> ACME ${price}`);
    await app.publishEvent({
      eventId: `price-${i + 1}`,
      source: 'price',
      tenantId: alice.tenantId,
      payload: { symbol: 'ACME', price },
    });
  }
  await app.runUntilIdle();
  await turn('Anything new?', 'turn-2');

  const monitorStatus = (await app.getTask(monitorTask!.value.taskId, alice))
    .status;
  log(`monitor task: ${monitorStatus}`);
  return {
    replies,
    activations,
    monitorTaskId: monitorTask!.value.taskId,
    monitorStatus,
    notifications: (await app.listInbox({}, alice)).entries,
  };
}

if (isMain(import.meta.url)) {
  runPriceWatch({ log: (l) => console.log(l) }).catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
