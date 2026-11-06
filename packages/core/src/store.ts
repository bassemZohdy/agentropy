/**
 * Driver-neutral Store port (ADR-0017): named collections of JSON documents with revision CAS, a small set of
 * indexed fields per collection, and an async unit of work. Adapters must make one `transaction` atomic and
 * serialize transactions that touch the same store. No SQL-specific semantics leak through this interface.
 */
import { AgentropyError } from './errors.js';

export const STORE_COLLECTIONS = {
  tasks: ['tenantId', 'status', 'instanceId', 'parentTaskId'],
  executions: ['taskId', 'state'],
  checkpoints: ['taskId'],
  wakeups: ['taskId', 'status', 'dueAt'],
  subscriptions: ['taskId', 'source', 'status'],
  mailbox: ['taskId', 'subscriptionId', 'consumed'],
  inboundEvents: ['source'],
  effects: ['taskId'],
  outbox: ['published', 'aggregateId'],
  inbox: ['tenantId', 'ownerId', 'status'],
  humanActions: ['taskId', 'status'],
  idempotency: ['tenantId'],
  audit: ['tenantId', 'type'],
  gates: ['taskId', 'nextCheckAt'],
  instances: ['tenantId', 'ownerId'],
  sessions: ['tenantId'],
  leases: ['kind'],
  usage: ['taskId'],
  remoteTasks: ['tenantId', 'status', 'parentTaskId'],
} as const satisfies Record<string, readonly string[]>;

export type CollectionName = keyof typeof STORE_COLLECTIONS;
export type IndexField<C extends CollectionName> =
  (typeof STORE_COLLECTIONS)[C][number];
export type IndexValue = string | number | null;

export interface StoredDocument<T> {
  id: string;
  /** Starts at 1 and increases by one per update (compare-and-swap token). */
  revision: number;
  /** Store-wide monotonic insertion order. */
  seq: number;
  value: T;
}

export interface FindOptions<C extends CollectionName> {
  where?: Partial<Record<IndexField<C>, IndexValue>>;
  /** Inclusive range on one indexed field (e.g. due wake-ups: dueAt <= now). */
  range?: { field: IndexField<C>; gte?: IndexValue; lte?: IndexValue };
  orderBy?: 'seq' | IndexField<C>;
  afterSeq?: number;
  limit?: number;
}

export interface StoreTx {
  get<T>(
    collection: CollectionName,
    id: string,
  ): Promise<StoredDocument<T> | undefined>;
  /** Fails StaleRevision (`reason: "exists"`) when the ID is taken. */
  insert<T>(
    collection: CollectionName,
    id: string,
    value: T,
  ): Promise<StoredDocument<T>>;
  /** Compare-and-swap; fails StaleRevision when `expectedRevision` is not current. */
  update<T>(
    collection: CollectionName,
    id: string,
    expectedRevision: number,
    value: T,
  ): Promise<StoredDocument<T>>;
  remove(
    collection: CollectionName,
    id: string,
    expectedRevision: number,
  ): Promise<void>;
  find<T, C extends CollectionName = CollectionName>(
    collection: C,
    options?: FindOptions<C>,
  ): Promise<StoredDocument<T>[]>;
}

export interface Store {
  /** Durability the adapter itself provides across a process restart. */
  readonly durability: 'none' | 'durable-acceptance' | 'durable-execution';
  /** Runs `fn` atomically. A thrown error rolls back every write made through `tx`. */
  transaction<T>(fn: (tx: StoreTx) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** Extracts the indexed fields of a document value; missing fields index as null. */
export function indexValues(
  collection: CollectionName,
  value: unknown,
): Record<string, IndexValue> {
  const out: Record<string, IndexValue> = {};
  const v = (value ?? {}) as Record<string, unknown>;
  for (const field of STORE_COLLECTIONS[collection]) {
    const raw = v[field];
    if (raw === undefined || raw === null) out[field] = null;
    else if (typeof raw === 'string' || typeof raw === 'number')
      out[field] = raw;
    else if (typeof raw === 'boolean') out[field] = raw ? 1 : 0;
    else
      throw new AgentropyError(
        'Internal',
        `Indexed field ${collection}.${field} must be a scalar`,
      );
  }
  return out;
}

export const staleRevision = (
  collection: string,
  id: string,
  reason: 'exists' | 'missing' | 'revision',
  expected?: number,
  actual?: number,
) =>
  new AgentropyError('StaleRevision', `${collection}/${id}: ${reason}`, {
    details: {
      collection,
      reason,
      ...(expected !== undefined ? { expectedRevision: expected } : {}),
      ...(actual !== undefined ? { actualRevision: actual } : {}),
    },
  });

/** A FIFO async mutex: transactions on one store never interleave. */
export class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function compare(a: IndexValue, b: IndexValue): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return a < b ? -1 : 1;
}

/** Reference adapter (durability "none"): everything is lost when the process exits. */
export class MemoryStore implements Store {
  readonly durability = 'none' as const;
  private data = new Map<
    CollectionName,
    Map<string, StoredDocument<unknown>>
  >();
  private seq = 0;
  private closed = false;
  private readonly mutex = new AsyncMutex();

  transaction<T>(fn: (tx: StoreTx) => Promise<T>): Promise<T> {
    return this.mutex.run(async () => {
      if (this.closed)
        throw new AgentropyError('ProviderUnavailable', 'Store is closed');
      const snapshot = { data: structuredClone(this.data), seq: this.seq };
      try {
        return await fn(this.tx());
      } catch (err) {
        this.data = snapshot.data;
        this.seq = snapshot.seq;
        throw err;
      }
    });
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  private col(c: CollectionName) {
    let m = this.data.get(c);
    if (!m) this.data.set(c, (m = new Map()));
    return m;
  }

  private tx(): StoreTx {
    return {
      get: async <T>(c: CollectionName, id: string) =>
        structuredClone(this.col(c).get(id)) as StoredDocument<T> | undefined,
      insert: async <T>(c: CollectionName, id: string, value: T) => {
        if (this.col(c).has(id)) throw staleRevision(c, id, 'exists');
        indexValues(c, value);
        const doc: StoredDocument<T> = {
          id,
          revision: 1,
          seq: ++this.seq,
          value: structuredClone(value),
        };
        this.col(c).set(id, doc);
        return structuredClone(doc);
      },
      update: async <T>(
        c: CollectionName,
        id: string,
        expected: number,
        value: T,
      ) => {
        const cur = this.col(c).get(id);
        if (!cur) throw staleRevision(c, id, 'missing', expected);
        if (cur.revision !== expected)
          throw staleRevision(c, id, 'revision', expected, cur.revision);
        indexValues(c, value);
        const doc: StoredDocument<T> = {
          id,
          revision: cur.revision + 1,
          seq: cur.seq,
          value: structuredClone(value),
        };
        this.col(c).set(id, doc);
        return structuredClone(doc);
      },
      remove: async (c: CollectionName, id: string, expected: number) => {
        const cur = this.col(c).get(id);
        if (!cur) throw staleRevision(c, id, 'missing', expected);
        if (cur.revision !== expected)
          throw staleRevision(c, id, 'revision', expected, cur.revision);
        this.col(c).delete(id);
      },
      find: async <T, C extends CollectionName>(
        c: C,
        o: FindOptions<C> = {},
      ) => {
        let docs = [...this.col(c).values()].map((d) => ({
          d,
          idx: indexValues(c, d.value),
        }));
        for (const [field, v] of Object.entries(o.where ?? {}))
          docs = docs.filter((x) => x.idx[field] === v);
        if (o.range) {
          const { field, gte, lte } = o.range;
          docs = docs.filter(
            (x) =>
              x.idx[field] !== null &&
              (gte === undefined || compare(x.idx[field]!, gte) >= 0) &&
              (lte === undefined || compare(x.idx[field]!, lte) <= 0),
          );
        }
        if (o.afterSeq !== undefined)
          docs = docs.filter((x) => x.d.seq > o.afterSeq!);
        const by = o.orderBy ?? 'seq';
        docs.sort((a, b) =>
          by === 'seq'
            ? a.d.seq - b.d.seq
            : compare(a.idx[by]!, b.idx[by]!) || a.d.seq - b.d.seq,
        );
        return structuredClone(
          docs.slice(0, o.limit ?? docs.length).map((x) => x.d),
        ) as StoredDocument<T>[];
      },
    };
  }
}
