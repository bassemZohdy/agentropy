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
  redactDetails,
  type AuditEvent,
  type AuditIntentWriter,
  type Store,
  type StoreTx,
} from '@agentropy/core';
import type { FaultHook } from './outbox.js';

export interface AuditIntentRow {
  auditId: string;
  event: AuditEvent;
  forwarded: 0 | 1;
  attempts: number;
}

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
    await tx.insert<AuditIntentRow>('audit', auditId, {
      auditId,
      event: {
        ...event,
        ...(details && Object.keys(details).length ? { details } : {}),
      } as AuditEvent,
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
