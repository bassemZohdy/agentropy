/** Deterministic offline fakes (M1-10): clock, policy decision point, audit writer, grant verifier. */
import type {
  AuditEvent,
  AuditIntentWriter,
  PolicyDecision,
  PolicyDecisionPoint,
  PolicyRequest,
} from '@agentropy/core';

export class FakeClock {
  private ms: number;
  constructor(start = '2026-11-05T00:00:00.000Z') {
    this.ms = Date.parse(start);
  }
  now = (): string => new Date(this.ms).toISOString();
  advance(ms: number): string {
    this.ms += ms;
    return this.now();
  }
}

export class FakePolicy implements PolicyDecisionPoint {
  readonly denied = new Set<string>();
  readonly requests: PolicyRequest[] = [];
  down = false;
  /** Deny by action, or by `${action}@${resourceId}`. */
  async decide(request: PolicyRequest): Promise<PolicyDecision> {
    this.requests.push(request);
    if (this.down) throw new Error('policy decision point unavailable');
    return this.denied.has(request.action) ||
      this.denied.has(`${request.action}@${request.resource.id}`)
      ? { effect: 'deny' }
      : { effect: 'allow' };
  }
}

export class FakeAudit implements AuditIntentWriter {
  readonly events: AuditEvent[] = [];
  failing = false;
  async record(event: AuditEvent): Promise<void> {
    if (this.failing) throw new Error('audit store unavailable');
    this.events.push(structuredClone(event));
  }
}

export class FakeGrants {
  readonly status = new Map<string, 'valid' | 'expired' | 'revoked'>();
  async check(ref: string): Promise<'valid' | 'expired' | 'revoked'> {
    return this.status.get(ref) ?? 'valid';
  }
}
