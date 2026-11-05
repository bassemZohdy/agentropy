/**
 * Mandatory audit intent (Security v1 PEP step 4, ADR-0022/0025, SEC-03).
 *
 * An intent row is written in the same Store transaction as the protected change it describes, so the change
 * and its audit intent commit together or not at all. If the intent cannot be written the transaction aborts
 * and the caller receives `AuditCommitUnavailable`: nothing is committed or reported as committed.
 * `AuditForwarder` later hands committed intents to the external `AuditIntentWriter` sink, at least once, with a
 * stable `details.auditId` the sink uses to deduplicate after a crash between delivery and the delivered mark.
 */
import {
  AgentropyError,
  digestOf,
  enforcePolicy,
  type PolicyDecisionPoint,
  type TrustedPrincipal,
  redactDetails,
  type AuditEvent,
  type AuditIntentWriter,
  type Store,
  type StoreTx,
} from '@agentropy/core';
import type { FaultHook } from './outbox.js';

export interface AuditIntentRow {
  auditId: string;
  /** Indexed copies of event fields. */
  tenantId: string;
  type: string;
  event: AuditEvent;
  /** Hash chain per tenant (D-21 tamper evidence): hash = digest(prevHash, auditId, event). */
  prevHash: string;
  hash: string;
  forwarded: 0 | 1;
  attempts: number;
}

const GENESIS = 'sha256:genesis';
const chainHash = (prevHash: string, auditId: string, event: AuditEvent) =>
  digestOf({ prevHash, auditId, event });

/** Writes one intent row inside `tx`; any failure (including an injected one) is AuditCommitUnavailable. */
export async function recordAuditIntent(
  tx: StoreTx,
  auditId: string,
  event: Omit<AuditEvent, 'details'> & { details?: Record<string, unknown> },
  faults?: FaultHook,
): Promise<void> {
  try {
    faults?.checkpoint('audit.intent');
    const details = redactDetails(event.details);
    const stored = {
      ...event,
      ...(details && Object.keys(details).length ? { details } : {}),
    } as AuditEvent;
    // Same transaction as the previous link: Store transactions are serialized, so the chain cannot fork.
    const prev = (
      await tx.find<AuditIntentRow>('audit', {
        where: { tenantId: event.tenantId },
        orderBy: 'seq',
      })
    ).at(-1);
    const prevHash = prev?.value.hash ?? GENESIS;
    await tx.insert<AuditIntentRow>('audit', auditId, {
      auditId,
      tenantId: event.tenantId,
      type: event.type,
      event: stored,
      prevHash,
      hash: chainHash(prevHash, auditId, stored),
      forwarded: 0,
      attempts: 0,
    });
  } catch (cause) {
    throw new AgentropyError(
      'AuditCommitUnavailable',
      'Audit intent could not be committed',
      { details: { type: event.type }, cause },
    );
  }
}

export class AuditForwarder {
  constructor(
    private readonly o: {
      store: Store;
      sink: AuditIntentWriter;
      faults?: FaultHook;
    },
  ) {}

  /** Forward committed intents in commit order; stops at the first failure. Returns how many were forwarded. */
  async drain(): Promise<number> {
    const rows = (
      await this.o.store.transaction((tx) =>
        tx.find<AuditIntentRow>('audit', { orderBy: 'seq' }),
      )
    ).filter((r) => r.value.forwarded === 0);
    let n = 0;
    for (const row of rows) {
      try {
        await this.o.sink.record({
          ...row.value.event,
          details: { ...row.value.event.details, auditId: row.value.auditId },
        });
        this.o.faults?.checkpoint('audit.markForwarded');
      } catch (err) {
        await this.o.store.transaction(async (tx) => {
          const cur = await tx.get<AuditIntentRow>('audit', row.id);
          if (cur && cur.value.forwarded === 0)
            await tx.update<AuditIntentRow>('audit', cur.id, cur.revision, {
              ...cur.value,
              attempts: cur.value.attempts + 1,
            });
        });
        void err;
        return n;
      }
      await this.o.store.transaction(async (tx) => {
        const cur = await tx.get<AuditIntentRow>('audit', row.id);
        if (cur && cur.value.forwarded === 0)
          await tx.update<AuditIntentRow>('audit', cur.id, cur.revision, {
            ...cur.value,
            forwarded: 1,
          });
      });
      n++;
    }
    return n;
  }
}

/**
 * Audit read and integrity (D-21, SEC-05 M2 part): reads are tenant-scoped and need the independent `audit:read`
 * permission; another tenant's audit is NotFound (no disclosure). `verify` recomputes the per-tenant hash chain and
 * reports the first row whose content or link was altered. Retention, legal hold and archive integrity are M3.
 */
export class AuditService {
  constructor(private readonly o: { store: Store; pdp: PolicyDecisionPoint }) {}

  private async authorize(
    caller: TrustedPrincipal,
    tenantId: string,
    action: 'audit:read' | 'audit:verify',
  ): Promise<void> {
    if (!caller?.id || !caller.tenantId)
      throw new AgentropyError('Unauthenticated', 'No trusted principal');
    if (tenantId !== caller.tenantId)
      throw new AgentropyError('NotFound', 'Audit log not found');
    await enforcePolicy(this.o.pdp, {
      principal: caller,
      action,
      resource: { type: 'audit-log', id: tenantId, tenantId },
    });
  }

  async query(
    q: { tenantId: string; type?: string; limit?: number },
    caller: TrustedPrincipal,
  ): Promise<AuditEvent[]> {
    await this.authorize(caller, q.tenantId, 'audit:read');
    const rows = await this.o.store.transaction((tx) =>
      tx.find<AuditIntentRow>('audit', {
        where: { tenantId: q.tenantId, ...(q.type ? { type: q.type } : {}) },
        orderBy: 'seq',
      }),
    );
    return rows
      .slice(-Math.min(Math.max(q.limit ?? 100, 1), 1000))
      .map((r) => ({
        ...r.value.event,
        details: { ...r.value.event.details, auditId: r.value.auditId },
      }));
  }

  async verify(
    tenantId: string,
    caller: TrustedPrincipal,
  ): Promise<{ ok: true; count: number } | { ok: false; brokenAt: string }> {
    await this.authorize(caller, tenantId, 'audit:verify');
    const rows = await this.o.store.transaction((tx) =>
      tx.find<AuditIntentRow>('audit', {
        where: { tenantId },
        orderBy: 'seq',
      }),
    );
    let prev = GENESIS;
    for (const r of rows) {
      const v = r.value;
      if (v.prevHash !== prev || v.hash !== chainHash(prev, v.auditId, v.event))
        return { ok: false, brokenAt: v.auditId };
      prev = v.hash;
    }
    return { ok: true, count: rows.length };
  }
}
