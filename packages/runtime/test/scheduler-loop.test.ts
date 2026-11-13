// FIX-050: the loop `LocalApp.start()` runs. One tick at a time: an interval that fires while a tick is still in
// flight is skipped, so slow ticks do not queue behind each other and `stop()` returns after the current tick.
import { MemoryStore } from '@agentropy/core';
import { FakePolicy } from '@agentropy/testkit';
import { describe, expect, it, vi } from 'vitest';
import { createLocalApp } from '../src/app.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** An app whose ticks can be held: every tick starts with a sweep that waits for `gate`. */
function slowApp() {
  const app = createLocalApp({
    store: new MemoryStore(),
    pdp: new FakePolicy(),
  });
  let open!: () => void;
  let gate: Promise<void> | undefined = new Promise<void>((r) => (open = r));
  const ticks = { started: 0 };
  app.wakeups.addSweep(async () => {
    ticks.started++;
    await gate;
  });
  return {
    app,
    ticks,
    release: () => {
      gate = undefined;
      open();
    },
  };
}

describe('scheduler loop (FIX-050)', () => {
  it('skips intervals while a tick is in flight: nothing queues, and stop() settles after the current tick', async () => {
    const { app, ticks, release } = slowApp();
    const stop = app.start(5);
    await vi.waitFor(() => expect(ticks.started).toBe(1));
    await sleep(100); // about twenty intervals pass while the first tick is held
    expect(ticks.started).toBe(1);
    release();
    await stop();
    // Ticks queued behind the slow one would all run now, before stop() settles.
    expect(ticks.started).toBe(1);
    expect(app.schedulerStatus().running).toBe(false);
    await sleep(30);
    expect(ticks.started).toBe(1); // and none runs after the stop
  });

  it('goes on ticking at the interval once a slow tick has finished', async () => {
    const { app, ticks, release } = slowApp();
    const stop = app.start(5);
    await vi.waitFor(() => expect(ticks.started).toBe(1));
    await sleep(40);
    release();
    await vi.waitFor(() => expect(ticks.started).toBeGreaterThanOrEqual(4));
    expect(app.schedulerStatus().consecutiveFailures).toBe(0);
    expect(app.schedulerStatus().lastTickAt).toBeDefined();
    await stop();
    const after = ticks.started;
    await sleep(30);
    expect(ticks.started).toBe(after);
  });

  it('a failing tick does not hold the loop: the next interval starts a new one', async () => {
    const app = createLocalApp({
      store: new MemoryStore(),
      pdp: new FakePolicy(),
    });
    let n = 0;
    app.wakeups.addSweep(async () => void n++); // counts the ticks that start
    // A tick fails when the pool's tick throws (a sweep that throws is contained since FIX-052 and fails nothing).
    vi.spyOn(app.runtime, 'tick').mockRejectedValueOnce(
      new Error('first tick fails'),
    );
    const errors: string[] = [];
    const stop = app.start(5, { onError: (e) => errors.push(e.code) });
    await vi.waitFor(() => expect(n).toBeGreaterThanOrEqual(3));
    await stop();
    expect(errors).toEqual(['Internal']);
    expect(app.schedulerStatus().consecutiveFailures).toBe(0);
  });
});
