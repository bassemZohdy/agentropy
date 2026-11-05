/**
 * Deterministic, in-memory fault injection for provider/runtime contract tests.
 * A named operation can be configured to fail its next N invocations.
 */
export class FaultInjector {
  private readonly failures = new Map<
    string,
    { remaining: number; message: string }
  >();
  private readonly calls = new Map<string, number>();

  failNext(operation: string, times = 1, message = 'Injected failure'): void {
    if (!operation.trim()) throw new RangeError('Operation must be nonempty');
    if (!Number.isSafeInteger(times) || times < 1) {
      throw new RangeError('Failure count must be a positive safe integer');
    }
    this.failures.set(operation, { remaining: times, message });
  }

  checkpoint(operation: string): void {
    if (!operation.trim()) throw new RangeError('Operation must be nonempty');
    this.calls.set(operation, this.callCount(operation) + 1);
    const failure = this.failures.get(operation);
    if (!failure) return;
    failure.remaining--;
    if (failure.remaining === 0) this.failures.delete(operation);
    throw new Error(failure.message);
  }

  callCount(operation: string): number {
    return this.calls.get(operation) ?? 0;
  }

  pendingFailures(operation: string): number {
    return this.failures.get(operation)?.remaining ?? 0;
  }

  reset(): void {
    this.failures.clear();
    this.calls.clear();
  }
}
