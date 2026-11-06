/**
 * Policy decision cache (D-19, TASK-026.3): a PolicyDecisionPoint wrapper with explicit scope, expiry and
 * revocation freshness.
 *
 * - Scope: one entry per (tenant, principal, principal type, delegated grant, action, resource). Entries never
 *   cross tenants or principals, and a different grant reference is a different entry.
 * - Expiry: `ttlMs` bounds staleness (default 30 s). A decision is never served after it expires.
 * - Freshness: `invalidate` drops entries for a tenant, principal or grant at once (call it from grant revocation
 *   or policy-change notifications); `policyVersion` changes do the same when the PDP reports one.
 * - Across workers (FEAT-033.1): with `shared`, the cache reads invalidations other workers recorded in the store
 *   (`recordPolicyInvalidation`, written by `revokeAuthority`) before serving a hit, at most every `syncMs`. A
 *   revocation on one worker reaches every other within `syncMs`, not `ttlMs`. If the read fails, the cache drops
 *   everything and asks the PDP until a read succeeds.
 * - Failures are never cached: an outage, timeout or malformed decision always reaches the caller (fail closed),
 *   and a later call asks the PDP again.
 * - Grant validity itself is never cached: GrantVerifier checks stay per protected operation.
 */
import {
  AgentropyError,
  digestOf,
  type PolicyDecision,
  type PolicyDecisionPoint,
  type PolicyRequest,
  type Store,
  type StoreTx,
} from '@agentropy/core';

/** Which cached decisions an invalidation drops; every given field must match. */
export interface PolicyInvalidationFilter {
  tenantId?: string;
  principalId?: string;
  grantRef?: string;
}

/** The stored form: like the audit trail, it keeps the grant reference's digest, never the reference. */
interface InvalidationRow {
  tenantId?: string;
  principalId?: string;
  grantDigest?: string;
  at: string;
}

/**
 * How long invalidation rows are kept. A shared cache's `ttlMs` may not exceed it: an entry older than this has
 * expired anyway, so a worker that missed a pruned row serves nothing stale.
 */
export const POLICY_INVALIDATION_RETENTION_MS = 600_000;

/**
 * Records an invalidation for every worker's shared cache inside `tx` (commit it with the change it reflects,
 * e.g. a revocation's audit event) and prunes rows past the retention.
 */
export async function recordPolicyInvalidation(
  tx: StoreTx,
  id: string,
  filter: PolicyInvalidationFilter,
  now: string,
): Promise<void> {
  const horizon = Date.parse(now) - POLICY_INVALIDATION_RETENTION_MS;
  for (const old of await tx.find<InvalidationRow>('policyInvalidations', {
    orderBy: 'seq',
  })) {
    if (Date.parse(old.value.at) >= horizon) break;
    await tx.remove('policyInvalidations', old.id, old.revision);
  }
  await tx.insert<InvalidationRow>('policyInvalidations', id, {
    ...(filter.tenantId !== undefined ? { tenantId: filter.tenantId } : {}),
    ...(filter.principalId !== undefined
      ? { principalId: filter.principalId }
      : {}),
    ...(filter.grantRef !== undefined
      ? { grantDigest: digestOf(filter.grantRef) }
      : {}),
    at: now,
  });
}

export interface PolicyCacheOptions {
  ttlMs?: number;
  /** Maximum entries; the oldest are evicted first (default 10,000). */
  maxEntries?: number;
  now?: () => string;
  /** Cache only allows (default) or both allows and denies. */
  cacheDenies?: boolean;
  /** Apply invalidations recorded in this store by any worker; read at most every `syncMs` (default 1000). */
  shared?: { store: Store; syncMs?: number };
}

interface Entry {
  decision: PolicyDecision;
  expiresAt: number;
  tenantId: string;
  principalId: string;
  grantDigest?: string;
}

export class CachingPolicyDecisionPoint implements PolicyDecisionPoint {
  private readonly entries = new Map<string, Entry>();
  private lastPolicyVersion?: string;
  /** Last applied invalidation row; undefined until the first successful read. */
  private cursor?: number;
  private syncedAt = -Infinity;
  private syncing?: Promise<void>;
  hits = 0;
  misses = 0;

  constructor(
    private readonly pdp: PolicyDecisionPoint,
    private readonly o: PolicyCacheOptions = {},
  ) {
    if (o.shared && (o.ttlMs ?? 30_000) > POLICY_INVALIDATION_RETENTION_MS)
      throw new AgentropyError(
        'InvalidConfiguration',
        `A shared policy cache's ttlMs may not exceed ${POLICY_INVALIDATION_RETENTION_MS} ms`,
      );
  }

  /** Applies invalidations recorded since the last read; on failure drops every entry (fail closed). */
  private async sync(now: number): Promise<void> {
    const shared = this.o.shared;
    if (!shared || now - this.syncedAt < (shared.syncMs ?? 1_000)) return;
    this.syncing ??= (async () => {
      try {
        const rows = await shared.store.transaction((tx) =>
          tx.find<InvalidationRow>('policyInvalidations', {
            orderBy: 'seq',
            ...(this.cursor !== undefined ? { afterSeq: this.cursor } : {}),
          }),
        );
        // Before the first read the cache may hold entries decided before rows that are already stored.
        for (const r of rows) this.drop(r.value);
        this.cursor = rows.at(-1)?.seq ?? this.cursor ?? 0;
        this.syncedAt = now;
      } catch {
        this.entries.clear();
      } finally {
        this.syncing = undefined;
      }
    })();
    await this.syncing;
  }

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
      await this.sync(now);
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
          ? { grantDigest: digestOf(request.principal.delegatedAuthorityRef) }
          : {}),
      });
    }
    return decision;
  }

  /** Drop cached decisions immediately (revocation freshness). With no filter, clears everything. */
  invalidate(filter: PolicyInvalidationFilter = {}): number {
    return this.drop({
      ...(filter.tenantId !== undefined ? { tenantId: filter.tenantId } : {}),
      ...(filter.principalId !== undefined
        ? { principalId: filter.principalId }
        : {}),
      ...(filter.grantRef !== undefined
        ? { grantDigest: digestOf(filter.grantRef) }
        : {}),
    });
  }

  private drop(filter: Omit<InvalidationRow, 'at'>): number {
    let n = 0;
    for (const [k, e] of this.entries)
      if (
        (filter.tenantId === undefined || e.tenantId === filter.tenantId) &&
        (filter.principalId === undefined ||
          e.principalId === filter.principalId) &&
        (filter.grantDigest === undefined ||
          e.grantDigest === filter.grantDigest)
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
