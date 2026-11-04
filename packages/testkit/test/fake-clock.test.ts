import { describe, expect, it } from 'vitest';
import { FakeClock } from '../src/fake-clock.js';

describe('FakeClock', () => {
  it('fires scheduled events in stable due-time and insertion order', () => {
    const clock = new FakeClock(100);
    const events: string[] = [];
    clock.scheduleAt(150, () => events.push('last'));
    clock.scheduleAt(120, () => events.push('first'));
    clock.scheduleAt(120, () => events.push('second'));
    clock.advanceTo(119);
    expect(events).toEqual([]);
    clock.advanceTo(150);
    expect(events).toEqual(['first', 'second', 'last']);
    expect(clock.now()).toBe(150);
  });

  it('supports cancellation and callbacks that schedule more work', () => {
    const clock = new FakeClock();
    const seen: number[] = [];
    const removed = clock.scheduleAt(10, () => seen.push(-1));
    expect(clock.cancel(removed)).toBe(true);
    expect(clock.cancel(removed)).toBe(false);
    clock.scheduleAt(5, () => {
      seen.push(clock.now());
      clock.scheduleAt(8, () => seen.push(clock.now()));
    });
    clock.advanceBy(10);
    expect(seen).toEqual([5, 8]);
  });

  it('rejects time moving backwards and unsafe inputs', () => {
    const clock = new FakeClock(50);
    expect(() => clock.advanceTo(49)).toThrow(RangeError);
    expect(() => clock.advanceBy(-1)).toThrow(RangeError);
    expect(() => clock.scheduleAt(Number.NaN, () => {})).toThrow(RangeError);
  });
});
