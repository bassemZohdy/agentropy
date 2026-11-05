import { describe, expect, it } from 'vitest';
import { FaultInjector } from '../src/fault-injector.js';

describe('FaultInjector', () => {
  it('injects bounded failures, then allows recovery', () => {
    const faults = new FaultInjector();
    faults.failNext('store.commit', 2, 'db unavailable');

    expect(() => faults.checkpoint('store.commit')).toThrow('db unavailable');
    expect(() => faults.checkpoint('store.commit')).toThrow('db unavailable');
    expect(() => faults.checkpoint('store.commit')).not.toThrow();
    expect(faults.callCount('store.commit')).toBe(3);
    expect(faults.pendingFailures('store.commit')).toBe(0);
  });

  it('isolates operations and supports clearing all planned faults', () => {
    const faults = new FaultInjector();
    faults.failNext('audit.write');
    faults.failNext('pdp.evaluate', 2);
    expect(() => faults.checkpoint('audit.write')).toThrow('Injected failure');
    expect(faults.callCount('pdp.evaluate')).toBe(0);
    expect(faults.pendingFailures('pdp.evaluate')).toBe(2);
    faults.reset();
    expect(() => faults.checkpoint('pdp.evaluate')).not.toThrow();
    expect(faults.callCount('audit.write')).toBe(0);
    expect(faults.callCount('pdp.evaluate')).toBe(1);
  });

  it('validates operation names and failure counts', () => {
    const faults = new FaultInjector();
    expect(() => faults.failNext('')).toThrow(RangeError);
    expect(() => faults.failNext('tool', 0)).toThrow(RangeError);
    expect(() => faults.failNext('tool', Number.POSITIVE_INFINITY)).toThrow(
      RangeError,
    );
    expect(() => faults.checkpoint('  ')).toThrow(RangeError);
  });
});
