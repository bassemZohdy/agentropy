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
import { randomUUID } from 'node:crypto';
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

/** The newest link of a tenant's audit chain. */
interface AuditHead {
  tenantId: string;
  auditId: string;
  hash: string;
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
    const stored = {
      ...event,
      ...(details && Object.keys(details).length ? { details } : {}),
    } as AuditEvent;
    // Same transaction as the previous link: Store transactions are serialized, so the chain cannot fork.
    // The head row makes an append O(1) (FEAT-032.2); a store written before it existed is scanned once.
    const head = await tx.get<AuditHead>('auditHeads', event.tenantId);
    const prevHash =
      head?.value.hash ??
      (
        await tx.find<AuditIntentRow>('audit', {
          where: { tenantId: event.tenantId },
          orderBy: 'seq',
        })
      ).at(-1)?.value.hash ??
      GENESIS;
    const hash = chainHash(prevHash, auditId, stored);
    await tx.insert<AuditIntentRow>('audit', auditId, {
      auditId,
      tenantId: event.tenantId,
      type: event.type,
      event: stored,
      prevHash,
      hash,
      forwarded: 0,
      attempts: 0,
    });
    const next: AuditHead = { tenantId: event.tenantId, auditId, hash };
    if (head)
      await tx.update<AuditHead>(
        'auditHeads',
        event.tenantId,
        head.revision,
        next,
      );
    else await tx.insert<AuditHead>('auditHeads', event.tenantId, next);
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
      /** Clock for the drain budget (default: the system clock). */
      now?: () => string;
      /**
       * Longest a drain call keeps forwarding (default 5000 ms): a backlog after an outage is forwarded over several
       * calls, in order. At least one row is forwarded per call.
       */
      drainBudgetMs?: number;
    },
  ) {}

  /**
   * Forward committed intents in commit order; stops at the first failure. Returns how many were forwarded. Reads
   * only rows not yet forwarded (indexed), a batch at a time, so a tick costs what is pending, not the whole log.
   */
  async drain(): Promise<number> {
    const batch = 200;
    const at = () => Date.parse(this.o.now?.() ?? new Date().toISOString());
    const started = at();
    const spent = () => at() - started >= (this.o.drainBudgetMs ?? 5_000);
    let n = 0;
    for (;;) {
      const rows = await this.o.store.transaction((tx) =>
        tx.find<AuditIntentRow>('audit', {
          where: { forwarded: 0 },
          orderBy: 'seq',
          limit: batch,
        }),
      );
      const sent = await this.forward(rows, spent);
      n += sent;
      if (sent < batch || sent < rows.length || spent()) return n;
    }
  }

  private async forward(
    rows: { id: string; revision: number; value: AuditIntentRow }[],
    spent: () => boolean,
  ): Promise<number> {
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
      if (spent()) return n;
    }
    return n;
  }
}

/** Deployment retention (trusted configuration): tenants may lengthen but never shorten below `floorDays`. */
export interface AuditRetention {
  defaultDays: number;
  floorDays: number;
  /** Per event type, e.g. `{ "task.accept": 3650 }`; each is still raised to the floor. */
  perType?: Record<string, number>;
}

export interface AuditHold {
  holdId: string;
  tenantId: string;
  status: 'active' | 'released';
  reason: string;
  /** Matching rows: any type when absent; `at` within [from, to] when given. */
  types?: string[];
  from?: string;
  to?: string;
  placedBy: string;
  placedAt: string;
  releasedBy?: string;
  releasedAt?: string;
}

/** Head of a tenant's chain, published to an independently protected sink (ADR-0022 §7). */
export interface AuditAnchor {
  tenantId: string;
  /** 1-based position of the row in the tenant chain since genesis (disposed rows included). */
  position: number;
  auditId: string;
  hash: string;
  at: string;
}

/** WORM storage, a transparency log, a signing service… — anything the store's writers cannot rewrite. */
export interface AuditAnchorSink {
  publish(anchor: AuditAnchor): Promise<void>;
}

/** Non-sensitive record of a disposal: counts and hashes, never the disposed payloads. */
export interface AuditDisposalReceipt {
  receiptId: string;
  tenantId: string;
  /** Chain positions disposed (inclusive). */
  fromPosition: number;
  toPosition: number;
  /** prevHash of the first and hash of the last disposed row: links the receipt into the chain. */
  startHash: string;
  lastHash: string;
  countByType: Record<string, number>;
  oldestAt: string;
  newestAt: string;
  authorizedBy: string;
  at: string;
}

export interface AuditExport {
  tenantId: string;
  /** Hash the first exported row links to (genesis or the last disposal receipt). */
  startHash: string;
  startPosition: number;
  rows: {
    auditId: string;
    event: AuditEvent;
    prevHash: string;
    hash: string;
  }[];
  exportedAt: string;
}

type AuditAction =
  | 'audit:read'
  | 'audit:verify'
  | 'audit:export'
  | 'audit:retention'
  | 'audit:hold'
  | 'audit:release-hold'
  | 'audit:anchor'
  | 'audit:dispose';

type VerifyResult =
  | { ok: true; count: number; disposed: number }
  | {
      ok: false;
      brokenAt: string;
      reason?: 'anchor-mismatch' | 'truncated' | 'receipt-chain';
    };

/** Pure chain check, usable offline on an export (archive integrity). */
export function verifyAuditChain(
  rows: {
    auditId: string;
    event: AuditEvent;
    prevHash: string;
    hash: string;
  }[],
  startHash = GENESIS,
): { ok: true } | { ok: false; brokenAt: string } {
  let prev = startHash;
  for (const v of rows) {
    if (v.prevHash !== prev || v.hash !== chainHash(prev, v.auditId, v.event))
      return { ok: false, brokenAt: v.auditId };
    prev = v.hash;
  }
  return { ok: true };
}

const DAY = 86_400_000;

/**
 * Audit read, integrity and lifecycle (D-21, D-22, ADR-0022). Every operation is tenant-scoped (another tenant's
 * log is NotFound) and needs its own permission — read, verify, export, retention, hold, release-hold, anchor and
 * dispose are independent actions. Each use is itself audited (`audit.*` events, recorded after the operation so
 * reading the log does not recurse).
 *
 * Lifecycle: rows expire after the tenant's retention (never below the deployment floor). `dispose` removes only
 * the oldest contiguous run of rows that are expired, already forwarded to the audit sink, and not matched by an
 * active legal hold, and leaves a receipt with counts and boundary hashes so `verify` still links the remaining
 * chain to genesis. `anchor` publishes the chain head to an external sink; `verify` checks such anchors, which
 * detects truncation and wholesale rewriting that a hash chain alone cannot.
 */
export class AuditService {
  constructor(
    private readonly o: {
      store: Store;
      pdp: PolicyDecisionPoint;
      now?: () => string;
      newId?: () => string;
      retention?: AuditRetention;
      anchorSink?: AuditAnchorSink;
    },
  ) {}

  private now() {
    return this.o.now?.() ?? new Date().toISOString();
  }
  private id(kind: string) {
    return this.o.newId?.() ?? `${kind}-${randomUUID()}`;
  }

  private async authorize(
    caller: TrustedPrincipal,
    tenantId: string,
    action: AuditAction,
  ): Promise<void> {
    if (!caller?.id || !caller.tenantId)
      throw new AgentropyError('Unauthenticated', 'No trusted principal');
    if (tenantId !== caller.tenantId)
      throw new AgentropyError('NotFound', 'Audit log not found');
    try {
      await enforcePolicy(this.o.pdp, {
        principal: caller,
        action,
        resource: { type: 'audit-log', id: tenantId, tenantId },
      });
    } catch (err) {
      // Denied audit access is itself an audit event (ADR-0022 §3).
      if ((err as { code?: string }).code === 'PermissionDenied')
        await this.o.store
          .transaction((tx) =>
            this.record(tx, caller, action, 'deny', { reason: 'policy' }),
          )
          .catch(() => undefined);
      throw err;
    }
  }

  private record(
    tx: StoreTx,
    caller: TrustedPrincipal,
    action: AuditAction,
    decision: 'allow' | 'deny',
    details?: Record<string, unknown>,
  ) {
    return recordAuditIntent(tx, this.id('audit'), {
      type: `audit.${action.slice('audit:'.length)}`,
      tenantId: caller.tenantId,
      principalId: caller.id,
      action,
      resource: { type: 'audit-log', id: caller.tenantId },
      decision,
      at: this.now(),
      ...(details ? { details } : {}),
    });
  }

  private rows(tx: StoreTx, tenantId: string) {
    return tx.find<AuditIntentRow>('audit', {
      where: { tenantId },
      orderBy: 'seq',
    });
  }

  private async receipts(tx: StoreTx, tenantId: string) {
    return (
      await tx.find<AuditDisposalReceipt>('auditReceipts', {
        where: { tenantId },
        orderBy: 'seq',
      })
    ).map((r) => r.value);
  }

  async query(
    q: { tenantId: string; type?: string; limit?: number },
    caller: TrustedPrincipal,
  ): Promise<AuditEvent[]> {
    await this.authorize(caller, q.tenantId, 'audit:read');
    return this.o.store.transaction(async (tx) => {
      // The newest N, read newest-first with a limit (not the whole log), returned oldest-first.
      const rows = await tx.find<AuditIntentRow>('audit', {
        where: { tenantId: q.tenantId, ...(q.type ? { type: q.type } : {}) },
        orderBy: 'seq',
        descending: true,
        limit: Math.min(Math.max(q.limit ?? 100, 1), 1000),
      });
      const out = rows.reverse().map((r) => ({
        ...r.value.event,
        details: { ...r.value.event.details, auditId: r.value.auditId },
      }));
      await this.record(tx, caller, 'audit:read', 'allow', {
        ...(q.type ? { filterType: q.type } : {}),
        returned: out.length,
      });
      return out;
    });
  }

  async verify(
    tenantId: string,
    caller: TrustedPrincipal,
    options: { anchors?: AuditAnchor[] } = {},
  ): Promise<VerifyResult> {
    await this.authorize(caller, tenantId, 'audit:verify');
    const { rows, receipts } = await this.o.store.transaction(async (tx) => ({
      rows: (await this.rows(tx, tenantId)).map((r) => r.value),
      receipts: await this.receipts(tx, tenantId),
    }));
    const result = checkChain(tenantId, rows, receipts, options.anchors ?? []);
    await this.o.store.transaction((tx) =>
      this.record(tx, caller, 'audit:verify', 'allow', {
        ok: result.ok,
        ...(result.ok ? {} : { brokenAt: result.brokenAt }),
        anchors: options.anchors?.length ?? 0,
      }),
    );
    return result;
  }

  /** Archive bundle: rows with their links, verifiable offline with `verifyAuditChain(rows, startHash)`. */
  async exportLog(
    tenantId: string,
    caller: TrustedPrincipal,
  ): Promise<AuditExport> {
    await this.authorize(caller, tenantId, 'audit:export');
    return this.o.store.transaction(async (tx) => {
      const receipts = await this.receipts(tx, tenantId);
      const last = receipts.at(-1);
      const rows = (await this.rows(tx, tenantId)).map((r) => ({
        auditId: r.value.auditId,
        event: r.value.event,
        prevHash: r.value.prevHash,
        hash: r.value.hash,
      }));
      await this.record(tx, caller, 'audit:export', 'allow', {
        rows: rows.length,
      });
      return {
        tenantId,
        startHash: last?.lastHash ?? GENESIS,
        startPosition: (last?.toPosition ?? 0) + 1,
        rows,
        exportedAt: this.now(),
      };
    });
  }

  private retention(): AuditRetention {
    return this.o.retention ?? { defaultDays: 365, floorDays: 30 };
  }

  /** Tenant retention override; can only lengthen relative to the deployment floor. */
  async setRetention(
    tenantId: string,
    policy: { days: number; perType?: Record<string, number> },
    caller: TrustedPrincipal,
  ): Promise<void> {
    await this.authorize(caller, tenantId, 'audit:retention');
    const { floorDays } = this.retention();
    const all = [policy?.days, ...Object.values(policy?.perType ?? {})];
    if (all.some((d) => !Number.isInteger(d) || d < floorDays))
      throw new AgentropyError(
        'SchemaViolation',
        `Retention must be whole days and at least the ${floorDays}-day floor`,
        { details: { reason: 'belowFloor', floorDays } },
      );
    await this.o.store.transaction(async (tx) => {
      const cur = await tx.get('auditPolicies', tenantId);
      const value = {
        tenantId,
        days: policy.days,
        ...(policy.perType ? { perType: policy.perType } : {}),
      };
      if (cur) await tx.update('auditPolicies', tenantId, cur.revision, value);
      else await tx.insert('auditPolicies', tenantId, value);
      await this.record(tx, caller, 'audit:retention', 'allow', {
        days: policy.days,
        perTypeCount: Object.keys(policy.perType ?? {}).length,
      });
    });
  }

  async placeHold(
    tenantId: string,
    hold: {
      holdId: string;
      reason: string;
      types?: string[];
      from?: string;
      to?: string;
    },
    caller: TrustedPrincipal,
  ): Promise<AuditHold> {
    await this.authorize(caller, tenantId, 'audit:hold');
    if (!hold?.holdId || !hold.reason)
      throw new AgentropyError(
        'SchemaViolation',
        'holdId and reason are required',
      );
    return this.o.store.transaction(async (tx) => {
      const id = `${tenantId}|${hold.holdId}`;
      const existing = await tx.get<AuditHold>('auditHolds', id);
      if (existing?.value.status === 'active') return existing.value;
      const value: AuditHold = {
        holdId: hold.holdId,
        tenantId,
        status: 'active',
        reason: hold.reason,
        ...(hold.types ? { types: [...hold.types] } : {}),
        ...(hold.from ? { from: hold.from } : {}),
        ...(hold.to ? { to: hold.to } : {}),
        placedBy: caller.id,
        placedAt: this.now(),
      };
      if (existing) await tx.update('auditHolds', id, existing.revision, value);
      else await tx.insert('auditHolds', id, value);
      await this.record(tx, caller, 'audit:hold', 'allow', {
        holdId: hold.holdId,
      });
      return value;
    });
  }

  /** Release returns matching rows to normal retention; it never deletes anything by itself. */
  async releaseHold(
    tenantId: string,
    holdId: string,
    caller: TrustedPrincipal,
  ): Promise<AuditHold> {
    await this.authorize(caller, tenantId, 'audit:release-hold');
    return this.o.store.transaction(async (tx) => {
      const doc = await tx.get<AuditHold>(
        'auditHolds',
        `${tenantId}|${holdId}`,
      );
      if (!doc) throw new AgentropyError('NotFound', 'Hold not found');
      if (doc.value.status === 'released') return doc.value;
      const value: AuditHold = {
        ...doc.value,
        status: 'released',
        releasedBy: caller.id,
        releasedAt: this.now(),
      };
      await tx.update('auditHolds', doc.id, doc.revision, value);
      await this.record(tx, caller, 'audit:release-hold', 'allow', { holdId });
      return value;
    });
  }

  /** Publish the current chain head to the external anchor sink and return it. */
  async anchor(
    tenantId: string,
    caller: TrustedPrincipal,
  ): Promise<AuditAnchor> {
    await this.authorize(caller, tenantId, 'audit:anchor');
    if (!this.o.anchorSink)
      throw new AgentropyError(
        'InvalidConfiguration',
        'No audit anchor sink is configured',
      );
    // Record the anchoring first, so the anchor covers its own event.
    const head = await this.o.store.transaction(async (tx) => {
      await this.record(tx, caller, 'audit:anchor', 'allow');
      const receipts = await this.receipts(tx, tenantId);
      const rows = await this.rows(tx, tenantId);
      const last = rows.at(-1)!.value;
      return {
        tenantId,
        position: (receipts.at(-1)?.toPosition ?? 0) + rows.length,
        auditId: last.auditId,
        hash: last.hash,
        at: this.now(),
      };
    });
    await this.o.anchorSink.publish(head);
    return head;
  }

  /**
   * Remove the oldest expired, forwarded, unheld rows (a contiguous prefix of the chain) and record a receipt.
   * Returns undefined when nothing is eligible.
   */
  async dispose(
    tenantId: string,
    caller: TrustedPrincipal,
  ): Promise<AuditDisposalReceipt | undefined> {
    await this.authorize(caller, tenantId, 'audit:dispose');
    const now = this.now();
    return this.o.store.transaction(async (tx) => {
      const retention = this.retention();
      const tenantPolicy = (
        await tx.get<{ days: number; perType?: Record<string, number> }>(
          'auditPolicies',
          tenantId,
        )
      )?.value;
      const holds = (
        await tx.find<AuditHold>('auditHolds', {
          where: { tenantId, status: 'active' },
        })
      ).map((h) => h.value);
      const daysFor = (type: string) =>
        Math.max(
          retention.floorDays,
          tenantPolicy?.perType?.[type] ??
            retention.perType?.[type] ??
            tenantPolicy?.days ??
            retention.defaultDays,
        );
      const held = (e: AuditEvent) =>
        holds.some(
          (h) =>
            (!h.types || h.types.includes(e.type)) &&
            (!h.from || e.at >= h.from) &&
            (!h.to || e.at <= h.to),
        );
      const rows = await this.rows(tx, tenantId);
      const prefix: typeof rows = [];
      for (const r of rows) {
        const v = r.value;
        const expired =
          Date.parse(v.event.at) + daysFor(v.type) * DAY <= Date.parse(now);
        if (!expired || v.forwarded !== 1 || held(v.event)) break;
        prefix.push(r);
      }
      if (!prefix.length) {
        await this.record(tx, caller, 'audit:dispose', 'allow', {
          disposed: 0,
        });
        return undefined;
      }
      const receipts = await this.receipts(tx, tenantId);
      const fromPosition = (receipts.at(-1)?.toPosition ?? 0) + 1;
      const countByType: Record<string, number> = {};
      for (const r of prefix)
        countByType[r.value.type] = (countByType[r.value.type] ?? 0) + 1;
      const receipt: AuditDisposalReceipt = {
        receiptId: this.id('receipt'),
        tenantId,
        fromPosition,
        toPosition: fromPosition + prefix.length - 1,
        startHash: prefix[0]!.value.prevHash,
        lastHash: prefix.at(-1)!.value.hash,
        countByType,
        oldestAt: prefix[0]!.value.event.at,
        newestAt: prefix.at(-1)!.value.event.at,
        authorizedBy: caller.id,
        at: now,
      };
      for (const r of prefix) await tx.remove('audit', r.id, r.revision);
      await tx.insert('auditReceipts', receipt.receiptId, receipt);
      await this.record(tx, caller, 'audit:dispose', 'allow', {
        disposed: prefix.length,
        receiptId: receipt.receiptId,
      });
      return receipt;
    });
  }
}

function checkChain(
  tenantId: string,
  rows: AuditIntentRow[],
  receipts: AuditDisposalReceipt[],
  anchors: AuditAnchor[],
): VerifyResult {
  let prev = GENESIS;
  let position = 0;
  for (const r of receipts) {
    if (r.startHash !== prev || r.fromPosition !== position + 1)
      return { ok: false, brokenAt: r.receiptId, reason: 'receipt-chain' };
    prev = r.lastHash;
    position = r.toPosition;
  }
  const disposed = position;
  const chain = verifyAuditChain(rows, prev);
  if (!chain.ok) return chain;
  for (const a of anchors) {
    if (a.tenantId !== tenantId) continue;
    if (a.position <= disposed) {
      const end = receipts.find((r) => r.toPosition === a.position);
      if (end && end.lastHash !== a.hash)
        return { ok: false, brokenAt: a.auditId, reason: 'anchor-mismatch' };
      continue;
    }
    const row = rows[a.position - disposed - 1];
    if (!row) return { ok: false, brokenAt: a.auditId, reason: 'truncated' };
    if (row.auditId !== a.auditId || row.hash !== a.hash)
      return { ok: false, brokenAt: a.auditId, reason: 'anchor-mismatch' };
  }
  return { ok: true, count: rows.length, disposed };
}
