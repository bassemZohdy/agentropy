export interface ScheduledCall {
  readonly id: number;
  readonly dueAt: number;
  readonly callback: () => void;
}

/** Deterministic, synchronous fake clock for tests; no real timers or wall clock. */
export class FakeClock {
  private timestamp: number;
  private nextId = 0;
  private scheduled: ScheduledCall[] = [];

  constructor(initialEpochMs = 0) {
    if (!Number.isSafeInteger(initialEpochMs)) {
      throw new RangeError('Invalid initial time');
    }
    this.timestamp = initialEpochMs;
  }

  now(): number {
    return this.timestamp;
  }

  scheduleAt(dueAt: number, callback: () => void): number {
    if (!Number.isSafeInteger(dueAt) || dueAt < this.timestamp) {
      throw new RangeError('Invalid scheduled time');
    }
    const id = ++this.nextId;
    this.scheduled.push({ id, dueAt, callback });
    return id;
  }

  cancel(id: number): boolean {
    const previous = this.scheduled.length;
    this.scheduled = this.scheduled.filter((item) => item.id !== id);
    return this.scheduled.length < previous;
  }

  advanceTo(epochMs: number): void {
    if (!Number.isSafeInteger(epochMs) || epochMs < this.timestamp) {
      throw new RangeError('Clock cannot move backwards or use an unsafe time');
    }
    let count = 0;
    while (true) {
      this.scheduled.sort((a, b) => a.dueAt - b.dueAt || a.id - b.id);
      const next = this.scheduled[0];
      if (!next || next.dueAt > epochMs) break;
      if (++count > 10000)
        throw new RangeError('Too many callbacks in one advance');
      this.scheduled.shift();
      this.timestamp = next.dueAt;
      next.callback();
    }
    this.timestamp = epochMs;
  }

  advanceBy(milliseconds: number): void {
    const validDelta = Number.isSafeInteger(milliseconds) && milliseconds >= 0;
    const nextTime = this.timestamp + milliseconds;
    if (!validDelta || !Number.isSafeInteger(nextTime)) {
      throw new RangeError('Invalid time delta');
    }
    this.advanceTo(nextTime);
  }
}
