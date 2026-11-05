/**
 * Policy decision cache (D-19, TASK-026.3): a PolicyDecisionPoint wrapper with explicit scope, expiry and
 * revocation freshness.
 *
 * - Scope: one entry per (tenant, principal, principal type, delegated grant, action, resource). Entries never
 *   cross tenants or principals, and a different grant reference is a different entry.
 * - Expiry: `ttlMs` bounds staleness (default 30 s). A decision is never served after it expires.
 * - Freshness: `invalidate` drops entries for a tenant, principal or grant at once (call it from grant revocation
 *   or policy-change notifications); `policyVersion` changes do the same when the PDP reports one.
 * - Failures are never cached: an outage, timeout or malformed decision always reaches the caller (fail closed),
 *   and a later call asks the PDP again.
 * - Grant validity itself is never cached: GrantVerifier checks stay per protected operation.
 */
import type {
  PolicyDecision,
  PolicyDecisionPoint,
  PolicyRequest,
} from '@agentropy/core';

export interface PolicyCacheOptions {
  ttlMs?: number;
  /** Maximum entries; the oldest are evicted first (default 10,000). */
  maxEntries?: number;
  now?: () => string;
  /** Cache only allows (default) or both allows and denies. */
  cacheDenies?: boolean;
}

interface Entry {
  decision: PolicyDecision;
  expiresAt: number;
  tenantId: string;
  principalId: string;
  grantRef?: string;
}

export class CachingPolicyDecisionPoint implements PolicyDecisionPoint {
  private readonly entries = new Map<string, Entry>();
  private lastPolicyVersion?: string;
  hits = 0;
  misses = 0;

  constructor(
    private readonly pdp: PolicyDecisionPoint,
    private readonly o: PolicyCacheOptions = {},
  ) {}

  private now(): number {
    return Date.parse(this.o.now?.() ?? new Date().toISOString());
  }

  private key(r: PolicyRequest): string {
    return JSON.stringify([
      r.resource.tenantId,
      r.principal.tenantId,
      r.principal.id,
      r.principal.type,
      r.principal.delegatedAuthorityRef ?? null,
      r.action,
      r.resource.type,
      r.resource.id,
    ]);
  }

  async decide(
    request: PolicyRequest,
    signal?: AbortSignal,
  ): Promise<PolicyDecision> {
    // Requests with extra context are evaluated every time: the cache key cannot see that context.
    const cacheable = request.context === undefined;
    const key = this.key(request);
    const now = this.now();
    if (cacheable) {
      const hit = this.entries.get(key);
      if (hit && hit.expiresAt > now) {
        this.hits++;
        return hit.decision;
      }
      if (hit) this.entries.delete(key);
    }
    this.misses++;
    const decision = await this.pdp.decide(request, signal);
    const effect = (decision as { effect?: unknown } | null)?.effect;
    if (effect !== 'allow' && effect !== 'deny') return decision; // malformed: not cached, caller fails closed
    if (
      decision.policyVersion !== undefined &&
      this.lastPolicyVersion !== undefined &&
      decision.policyVersion !== this.lastPolicyVersion
    )
      this.entries.clear(); // a new policy version invalidates everything decided under the old one
    if (decision.policyVersion !== undefined)
      this.lastPolicyVersion = decision.policyVersion;
    if (cacheable && (effect === 'allow' || this.o.cacheDenies)) {
      if (this.entries.size >= (this.o.maxEntries ?? 10_000)) {
        const oldest = this.entries.keys().next().value;
        if (oldest !== undefined) this.entries.delete(oldest);
      }
      this.entries.set(key, {
        decision,
        expiresAt: now + (this.o.ttlMs ?? 30_000),
        tenantId: request.resource.tenantId,
        principalId: request.principal.id,
        ...(request.principal.delegatedAuthorityRef
          ? { grantRef: request.principal.delegatedAuthorityRef }
          : {}),
      });
    }
    return decision;
  }

  /** Drop cached decisions immediately (revocation freshness). With no filter, clears everything. */
  invalidate(
    filter: { tenantId?: string; principalId?: string; grantRef?: string } = {},
  ): number {
    let n = 0;
    for (const [k, e] of this.entries)
      if (
        (filter.tenantId === undefined || e.tenantId === filter.tenantId) &&
        (filter.principalId === undefined ||
          e.principalId === filter.principalId) &&
        (filter.grantRef === undefined || e.grantRef === filter.grantRef)
      ) {
        this.entries.delete(k);
        n++;
      }
    return n;
  }

  get size(): number {
    return this.entries.size;
  }
}
