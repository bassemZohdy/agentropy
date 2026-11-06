/**
 * @agentropy/store-postgres — Store port adapter for PostgreSQL (ADR-0017, ADR-0028).
 *
 * Driver-neutral: the adapter talks to a {@link PgPool} (node-postgres `Pool` fits as-is) or to a single
 * {@link PgClient} connection (embedded PGlite fits as-is), so Agentropy carries no database driver dependency.
 *
 * Semantics, matching the SQLite adapter and the Store conformance suite:
 * - one `transaction` = one `BEGIN ISOLATION LEVEL SERIALIZABLE … COMMIT`; a serialization failure or deadlock
 *   re-runs the callback (bounded), so transaction callbacks must only touch the store;
 * - `seq` is assigned at commit (FEAT-032.3, ADR-0028 revision 2): just before `COMMIT`, a transaction that inserted
 *   rows takes a per-schema transaction advisory lock, draws one block from a PostgreSQL sequence and stamps its
 *   rows. The lock is held until the commit completes, so seq order equals commit order and readers paging with
 *   `afterSeq` never skip a row that commits late; neither the lock nor the sequence can cause a serialization
 *   failure, so concurrent writers no longer conflict on a counter row. Inside its own transaction an inserted row
 *   has a provisional seq above every committed one; the document `insert` returned carries the final seq once
 *   the transaction has committed;
 * - writes are buffered (FEAT-032.2, option `batchWrites`): inserts, and updates of rows the transaction has read
 *   or written, are sent together in one statement before the next read that could see them or at commit; at
 *   commit that statement also draws the seq block when only inserts are buffered. A taken ID or a stale revision
 *   then fails the transaction at that point rather than at the call. An acceptance takes 10 round trips (was 17);
 * - indexed fields live in typed side columns (`n_<field>` numeric, `s_<field>` text in "C" collation) so equality,
 *   ranges and ordering behave exactly like the in-memory reference (nulls first, code-unit string order).
 */
import {
  AgentropyError,
  METRICS,
  AsyncMutex,
  STORE_COLLECTIONS,
  indexValues,
  staleRevision,
  type CollectionName,
  type FindOptions,
  type IndexValue,
  type Store,
  type StoreTx,
  type StoredDocument,
  type Telemetry,
} from '@agentropy/core';

export const packageName = '@agentropy/store-postgres' as const;

/** Schema version this adapter writes; a newer database is refused with IncompatibleVersion. */
export const SCHEMA_VERSION = 2;

/** Provisional seq of rows inserted by a transaction that has not committed yet: above every committed seq. */
const PROVISIONAL_SEQ = 2 ** 52;

/** A row this transaction inserted: its place `k` in the seq block, and the documents to give the final seq. */
interface Inserted {
  c: CollectionName;
  id: string;
  k: number;
  /** Sent before the commit, with a provisional seq. */
  sent: boolean;
  docs: StoredDocument<unknown>[];
}

interface PendingWrite {
  c: CollectionName;
  id: string;
  /** Revision the row has once the write is applied. */
  revision: number;
  value: string;
  cols: string[];
  params: unknown[];
}

/** A buffered write (FEAT-032.2). An update of a buffered row replaces the buffered write. */
type Pending =
  | (PendingWrite & { kind: 'insert'; row: Inserted })
  | (PendingWrite & { kind: 'update'; expected: number });

/** Write-behind state of one transaction. */
interface TxState {
  inserted: Inserted[];
  rows: Map<string, Inserted>;
  pending: Map<string, Pending>;
  /** Revision and seq of rows this transaction has read or written. */
  known: Map<string, { revision: number; seq: number }>;
}

const keyOf = (c: CollectionName, id: string) => `${c}\u0000${id}`;

export interface PgResult<R> {
  rows: R[];
  /** node-postgres */
  rowCount?: number | null;
  /** PGlite */
  affectedRows?: number;
}

/** One connection: `query(text, params)` with `$1…$n` placeholders. */
export interface PgClient {
  query<R = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<PgResult<R>>;
}

/** A pool handing out dedicated connections (node-postgres `Pool`). */
export interface PgPool {
  connect(): Promise<PgClient & { release(err?: Error | boolean): void }>;
  end?(): Promise<void>;
}

export interface PostgresStoreOptions {
  /** Either a pool (concurrent transactions on separate connections) or one client (transactions serialized). */
  pool?: PgPool;
  client?: PgClient;
  /** Schema (namespace) holding Agentropy's tables. Default `agentropy`. */
  schema?: string;
  /** Re-runs after a serialization failure or deadlock before giving up with StaleRevision. Default 8. */
  maxRetries?: number;
  /**
   * From this re-run on, a retried transaction first takes a per-schema transaction-level advisory lock, so
   * transactions that keep losing queue behind each other instead of colliding again. Default 2.
   */
  serializeRetriesAfter?: number;
  /**
   * With a pool, prefer index scans inside transactions (`SET LOCAL enable_seqscan = off`) so serializable
   * transactions on small tables do not conflict through whole-table predicate locks. Default true.
   */
  preferIndexScans?: boolean;
  /**
   * Buffer inserts, and updates of rows the transaction has already read, and send them in one statement before
   * the next read that could see them or at commit (FEAT-032.2). A taken ID or a stale revision then fails at that
   * point instead of at the call; the transaction fails either way. Default true.
   */
  batchWrites?: boolean;
  /** Close the pool/client when the store closes. Default false (the caller owns the connection). */
  ownsConnection?: boolean;
  /**
   * Counts serialization conflicts and deadlocks as `agentropy.store.conflicts` with `agentropy.store.outcome`
   * `retried` (the transaction ran again) or `exhausted` (it failed StaleRevision after `maxRetries`).
   */
  telemetry?: Telemetry;
}

const RETRYABLE = new Set(['40001', '40P01']);
const SQLSTATE = /^[0-9A-Z]{5}$/;
const IDENT = /^[a-z_][a-z0-9_]{0,40}$/;

interface Row {
  id: string;
  revision: number | string;
  seq: number | string;
  value: string;
}

const toDoc = <T>(r: Row): StoredDocument<T> => ({
  id: r.id,
  revision: Number(r.revision),
  seq: Number(r.seq),
  value: JSON.parse(r.value) as T,
});

const affected = (r: PgResult<unknown>) =>
  r.rowCount ?? r.affectedRows ?? r.rows.length;

const pgCode = (err: unknown) =>
  typeof err === 'object' && err !== null && 'code' in err
    ? String((err as { code: unknown }).code)
    : undefined;

/**
 * Database errors never leave the adapter raw (they can carry SQL text and values): connection and shutdown
 * classes become ProviderUnavailable (retryable), anything else Internal. Only the SQLSTATE is kept.
 */
function fromSqlState(code: string): AgentropyError {
  const unavailable = /^(08|53|57P|58)/.test(code);
  return new AgentropyError(
    unavailable ? 'ProviderUnavailable' : 'Internal',
    unavailable ? 'Database unavailable' : 'Database error',
    { details: { sqlstate: code } },
  );
}

/** PostgreSQL store. Durable when the database is; HA is the database's concern (ADR-0028). */
export class PostgresStore implements Store {
  readonly durability = 'durable-execution' as const;
  private readonly schema: string;
  private readonly maxRetries: number;
  /** Serializes transactions when only one connection is available. */
  private readonly mutex = new AsyncMutex();
  private ready?: Promise<void>;
  private closed = false;
  /**
   * Under SERIALIZABLE a sequential scan predicate-locks the whole table, so two writers that each scan a small
   * table (where the planner prefers sequential scans even for primary-key lookups) conflict although they touch
   * different rows. PostgreSQL's documentation for serializable workloads recommends steering the planner to index
   * scans; pooled connections do so per transaction, in the same round trip as BEGIN. A single client serializes
   * transactions itself and needs nothing.
   */
  private async beginTransaction(db: PgClient): Promise<void> {
    const begin = 'BEGIN ISOLATION LEVEL SERIALIZABLE';
    const prefer = 'SET LOCAL enable_seqscan = off';
    if (!this.o.pool || this.o.preferIndexScans === false) {
      await db.query(begin);
      return;
    }
    // One round trip where the driver accepts several statements in a query (node-postgres does); otherwise two.
    if (this.multiStatement !== false) {
      try {
        await db.query(`${begin}; ${prefer}`);
        this.multiStatement = true;
        return;
      } catch (err) {
        if (this.multiStatement === true) throw err;
        this.multiStatement = false;
      }
    }
    await db.query(begin);
    await db.query(prefer);
  }
  private multiStatement?: boolean;

  private get retryLockKey() {
    return `agentropy-retry:${this.schema}`;
  }

  constructor(private readonly o: PostgresStoreOptions) {
    if (!o.pool === !o.client)
      throw new AgentropyError(
        'InvalidConfiguration',
        'PostgresStore needs exactly one of pool or client',
      );
    this.schema = o.schema ?? 'agentropy';
    if (!IDENT.test(this.schema))
      throw new AgentropyError(
        'InvalidConfiguration',
        `Invalid schema name ${this.schema}`,
      );
    this.maxRetries = o.maxRetries ?? 8;
  }

  private t(c: CollectionName) {
    return `"${this.schema}"."c_${c}"`;
  }

  /** Creates or checks the schema. Called lazily by the first transaction; safe to run from many workers. */
  migrate(): Promise<void> {
    this.ready ??= this.withConnection(async (db) => {
      await db.query('BEGIN');
      try {
        // One migrator at a time across every worker sharing the database.
        await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
          `agentropy-migrate:${this.schema}`,
        ]);
        await db.query(`CREATE SCHEMA IF NOT EXISTS "${this.schema}"`);
        await db.query(
          `CREATE TABLE IF NOT EXISTS "${this.schema}".schema_migrations (version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
        );
        const applied = (
          await db.query<{ v: number | null }>(
            `SELECT MAX(version) AS v FROM "${this.schema}".schema_migrations`,
          )
        ).rows[0]?.v;
        if ((applied ?? 0) > SCHEMA_VERSION)
          throw new AgentropyError(
            'IncompatibleVersion',
            `Database schema ${applied} is newer than this adapter (${SCHEMA_VERSION})`,
            { details: { kind: 'store-schema' } },
          );
        if ((applied ?? 0) < 1) await this.createV1(db);
        if ((applied ?? 0) < 2) await this.migrateV2(db);
        await this.evolve(db);
        await db.query('COMMIT');
      } catch (err) {
        await db.query('ROLLBACK').catch(() => undefined);
        throw err;
      }
    }).catch((err) => {
      this.ready = undefined;
      throw err;
    });
    return this.ready;
  }

  private async createV1(db: PgClient) {
    const s = `"${this.schema}"`;
    await db.query(
      `CREATE TABLE ${s}.meta (key TEXT PRIMARY KEY, value BIGINT NOT NULL)`,
    );
    await db.query(`INSERT INTO ${s}.meta (key, value) VALUES ('seq', 0)`);
    for (const [c, fields] of Object.entries(STORE_COLLECTIONS) as [
      CollectionName,
      readonly string[],
    ][])
      await this.createCollection(db, c, fields);
    await db.query(`INSERT INTO ${s}.schema_migrations (version) VALUES (1)`);
  }

  /**
   * Schema 2 (FEAT-032.3): seq comes from a sequence that continues after the old counter row. Every worker must run
   * a schema-2 adapter: a schema-1 worker still running would take seqs from the counter, below the sequence.
   */
  private async migrateV2(db: PgClient) {
    const s = `"${this.schema}"`;
    const last = (
      await db.query<{ value: string | number }>(
        `SELECT value FROM ${s}.meta WHERE key = 'seq'`,
      )
    ).rows[0]?.value;
    await db.query(
      `CREATE SEQUENCE ${s}.seq AS BIGINT START WITH ${Number(last ?? 0) + 1}`,
    );
    await db.query(`INSERT INTO ${s}.schema_migrations (version) VALUES (2)`);
  }

  /**
   * Sends the writes this transaction has buffered in one statement (FEAT-032.2). At commit (`final`) the same
   * statement also takes the per-schema seq lock, draws one block from the sequence for every row this transaction
   * inserted, inserts the buffered rows with their final seq and stamps rows sent earlier with a provisional one.
   * The lock is held until COMMIT, so blocks are drawn in commit order. Returns the first value of the block.
   */
  private async flush(
    db: PgClient,
    st: TxState,
    final: boolean,
  ): Promise<number | undefined> {
    const ops = [...st.pending.values()];
    const draw = final && st.inserted.length > 0;
    if (!ops.length && !draw) return undefined;
    // An update can wait on another transaction's row lock. It must not wait while holding the seq lock: every
    // inserting commit would queue behind it, and a holder of that row that also inserts would deadlock with it.
    if (draw && ops.some((op) => op.kind === 'update')) {
      await this.flush(db, st, false);
      return this.flush(db, st, true);
    }
    const params: unknown[] = [];
    const p = (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    };
    const ctes: string[] = [];
    if (draw) {
      const seq = `'"${this.schema}".seq'`;
      const n = p(st.inserted.length);
      ctes.push(
        `blk AS (SELECT setval(${seq}, nextval(${seq}) + ${n}::bigint - 1) - ${n}::bigint + 1 AS first ` +
          `FROM (SELECT pg_advisory_xact_lock(hashtext(${p(`agentropy-seq:${this.schema}`)}))) l)`,
      );
    }
    ops.forEach((op, i) => {
      if (op.kind === 'insert') {
        const seq = draw
          ? `(SELECT first FROM blk) + ${p(op.row.k)}::bigint`
          : p(PROVISIONAL_SEQ + op.row.k);
        const values = [
          p(op.id),
          p(op.revision),
          seq,
          p(op.value),
          ...op.params.map(p),
        ];
        ctes.push(
          `o${i} AS (INSERT INTO ${this.t(op.c)} (id, revision, seq, value${op.cols.map((c) => `, ${c}`).join('')}) ` +
            `VALUES (${values.join(', ')}) ON CONFLICT (id) DO NOTHING RETURNING 1)`,
        );
      } else {
        const sets = [
          `revision = ${p(op.revision)}`,
          `value = ${p(op.value)}`,
          ...op.cols.map((c, j) => `${c} = ${p(op.params[j])}`),
        ];
        ctes.push(
          `o${i} AS (UPDATE ${this.t(op.c)} SET ${sets.join(', ')} WHERE id = ${p(op.id)} AND revision = ${p(op.expected)} RETURNING 1)`,
        );
      }
    });
    if (draw) {
      // Rows sent before the commit carry a provisional seq; give them their place in the block.
      const byCollection = new Map<
        CollectionName,
        { ids: string[]; ks: number[] }
      >();
      for (const row of st.inserted)
        if (row.sent) {
          const e = byCollection.get(row.c) ?? { ids: [], ks: [] };
          e.ids.push(row.id);
          e.ks.push(row.k);
          byCollection.set(row.c, e);
        }
      [...byCollection.entries()].forEach(([c, e], j) =>
        ctes.push(
          `s${j} AS (UPDATE ${this.t(c)} t SET seq = blk.first + v.k FROM blk, ` +
            `unnest(${p(e.ids)}::text[], ${p(e.ks)}::int[]) AS v(id, k) WHERE t.id = v.id)`,
        ),
      );
    }
    const counts = ops.map(
      (_, i) => `, (SELECT count(*) FROM o${i})::int AS c${i}`,
    );
    const res = await db.query<Record<string, string | number | null>>(
      `WITH ${ctes.join(', ')} SELECT ${draw ? '(SELECT first FROM blk)' : 'NULL'} AS first${counts.join('')}`,
      params,
    );
    const row = res.rows[0]!;
    for (const [i, op] of ops.entries()) {
      if (Number(row[`c${i}`]) === 1) continue;
      if (op.kind === 'insert') throw staleRevision(op.c, op.id, 'exists');
      const cur = await this.current(db, op.c, op.id);
      if (cur === undefined)
        throw staleRevision(op.c, op.id, 'missing', op.expected);
      throw staleRevision(op.c, op.id, 'revision', op.expected, cur);
    }
    st.pending.clear();
    for (const op of ops) {
      const key = keyOf(op.c, op.id);
      if (op.kind === 'insert') {
        op.row.sent = true;
        st.known.set(key, {
          revision: op.revision,
          seq: PROVISIONAL_SEQ + op.row.k,
        });
      } else
        st.known.set(key, {
          revision: op.revision,
          seq: st.known.get(key)!.seq,
        });
    }
    return draw ? Number(row.first) : undefined;
  }

  private async current(db: PgClient, c: CollectionName, id: string) {
    const r = (
      await db.query<{ revision: number }>(
        `SELECT revision FROM ${this.t(c)} WHERE id = $1`,
        [id],
      )
    ).rows[0];
    return r ? Number(r.revision) : undefined;
  }

  /**
   * Additive schema evolution (FEAT-028.3): collections and index fields added by newer releases get their tables
   * and columns on start, and new columns are backfilled from the stored JSON. Runs under the migration lock.
   */
  private async evolve(db: PgClient) {
    const existing = new Map<string, Set<string>>();
    for (const r of (
      await db.query<{ table_name: string; column_name: string }>(
        'SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = $1',
        [this.schema],
      )
    ).rows) {
      const cols = existing.get(r.table_name) ?? new Set<string>();
      cols.add(r.column_name);
      existing.set(r.table_name, cols);
    }
    for (const [c, fields] of Object.entries(STORE_COLLECTIONS) as [
      CollectionName,
      readonly string[],
    ][]) {
      const have = existing.get(`c_${c}`);
      if (!have) {
        await this.createCollection(db, c, fields);
        continue;
      }
      const missing = fields.filter((f) => !have.has(`n_${f}`));
      if (!missing.length) continue;
      for (const f of missing) {
        await db.query(
          `ALTER TABLE ${this.t(c)} ADD COLUMN "n_${f}" DOUBLE PRECISION, ADD COLUMN "s_${f}" TEXT COLLATE "C"`,
        );
        await db.query(
          `CREATE INDEX "x_${c}_${f}" ON ${this.t(c)} ("n_${f}", "s_${f}", seq)`,
        );
      }
      const rows = (
        await db.query<{ id: string; value: string }>(
          `SELECT id, value FROM ${this.t(c)}`,
        )
      ).rows;
      for (const r of rows) {
        const idx = indexValues(c, JSON.parse(r.value));
        const params = missing.flatMap((f): unknown[] => {
          const v = idx[f] ?? null;
          return typeof v === 'number' ? [v, null] : [null, v];
        });
        await db.query(
          `UPDATE ${this.t(c)} SET ${missing.map((f, i) => `"n_${f}" = $${2 * i + 1}, "s_${f}" = $${2 * i + 2}`).join(', ')} WHERE id = $${2 * missing.length + 1}`,
          [...params, r.id],
        );
      }
    }
  }

  private async createCollection(
    db: PgClient,
    c: CollectionName,
    fields: readonly string[],
  ) {
    const cols = fields
      .map((f) => `"n_${f}" DOUBLE PRECISION, "s_${f}" TEXT COLLATE "C"`)
      .join(', ');
    await db.query(
      `CREATE TABLE ${this.t(c)} (id TEXT COLLATE "C" PRIMARY KEY, revision INTEGER NOT NULL, seq BIGINT NOT NULL, value TEXT NOT NULL${cols ? `, ${cols}` : ''})`,
    );
    await db.query(`CREATE INDEX "x_${c}_seq" ON ${this.t(c)} (seq)`);
    for (const f of fields)
      await db.query(
        `CREATE INDEX "x_${c}_${f}" ON ${this.t(c)} ("n_${f}", "s_${f}", seq)`,
      );
  }

  private async withConnection<T>(fn: (db: PgClient) => Promise<T>) {
    if (this.o.client) return this.mutex.run(() => fn(this.o.client!));
    const conn = await this.o.pool!.connect();
    let broken = false;
    try {
      return await fn(conn);
    } catch (err) {
      // A connection that failed mid-protocol is not returned to the pool.
      broken = pgCode(err) === undefined && !(err instanceof AgentropyError);
      throw err;
    } finally {
      conn.release(broken);
    }
  }

  async transaction<T>(fn: (tx: StoreTx) => Promise<T>): Promise<T> {
    if (this.closed)
      throw new AgentropyError('ProviderUnavailable', 'Store is closed');
    await this.migrate();
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.withConnection(async (db) => {
          // Taken before BEGIN: a SERIALIZABLE snapshot starts at the first statement, so waiting inside the
          // transaction would hand the winner of the queue a stale snapshot.
          const queued = attempt >= (this.o.serializeRetriesAfter ?? 2);
          if (queued)
            await db.query('SELECT pg_advisory_lock(hashtext($1))', [
              this.retryLockKey,
            ]);
          try {
            await this.beginTransaction(db);
            try {
              const st: TxState = {
                inserted: [],
                rows: new Map(),
                pending: new Map(),
                known: new Map(),
              };
              const result = await fn(this.tx(db, st));
              const first = await this.flush(db, st, true);
              await db.query('COMMIT');
              if (first !== undefined)
                for (const row of st.inserted)
                  for (const doc of row.docs) doc.seq = first + row.k;
              return result;
            } catch (err) {
              await db.query('ROLLBACK').catch(() => undefined);
              throw err;
            }
          } finally {
            if (queued)
              await db.query('SELECT pg_advisory_unlock(hashtext($1))', [
                this.retryLockKey,
              ]);
          }
        });
      } catch (err) {
        if (err instanceof AgentropyError) throw err;
        const code = pgCode(err);
        if (!code || !SQLSTATE.test(code)) throw err;
        if (!RETRYABLE.has(code)) throw fromSqlState(code);
        const exhausted = attempt >= this.maxRetries;
        this.o.telemetry?.count(METRICS.storeConflicts, 1, {
          'agentropy.store.adapter': 'postgres',
          'agentropy.store.outcome': exhausted ? 'exhausted' : 'retried',
          'agentropy.store.sqlstate': code,
        });
        if (exhausted)
          throw new AgentropyError(
            'StaleRevision',
            'Transaction kept conflicting with concurrent writers',
            { details: { reason: 'serialization', attempts: attempt + 1 } },
          );
        await new Promise((r) =>
          setTimeout(r, Math.random() * 5 * 2 ** Math.min(attempt, 5)),
        );
      }
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.o.ownsConnection) {
      if (this.o.pool?.end) await this.o.pool.end();
      const c = this.o.client as { close?: () => Promise<void> } | undefined;
      if (c?.close) await this.mutex.run(() => c.close!());
    }
  }

  private tx(db: PgClient, st: TxState): StoreTx {
    const batch = this.o.batchWrites !== false;
    const seen = <T>(c: CollectionName, d: StoredDocument<T>) => {
      st.known.set(keyOf(c, d.id), { revision: d.revision, seq: d.seq });
      return d;
    };
    const get = async <T>(c: CollectionName, id: string) => {
      if (st.pending.has(keyOf(c, id))) await this.flush(db, st, false);
      const r = (
        await db.query<Row>(
          `SELECT id, revision, seq, value FROM ${this.t(c)} WHERE id = $1`,
          [id],
        )
      ).rows[0];
      return r ? seen(c, toDoc<T>(r)) : undefined;
    };
    const sendUnlessBatched = async () => {
      if (!batch) await this.flush(db, st, false);
    };
    const split = (v: IndexValue): [number | null, string | null] =>
      v === null ? [null, null] : typeof v === 'number' ? [v, null] : [null, v];
    const indexParams = (c: CollectionName, value: unknown) => {
      const idx = indexValues(c, value);
      const fields = Object.keys(idx);
      return {
        cols: fields.flatMap((f) => [`"n_${f}"`, `"s_${f}"`]),
        params: fields.flatMap((f) => split(idx[f]!)),
      };
    };
    const allowed = (c: CollectionName, field: string) => {
      if (!(STORE_COLLECTIONS[c] as readonly string[]).includes(field))
        throw new AgentropyError('Internal', `${c}.${field} is not indexed`);
    };
    return {
      get,
      insert: async <T>(c: CollectionName, id: string, value: T) => {
        const { cols, params } = indexParams(c, value);
        const key = keyOf(c, id);
        if (st.known.has(key) || st.pending.has(key))
          throw staleRevision(c, id, 'exists');
        // Buffered until the next read of this collection or the commit; the final seq is assigned at commit.
        // Until then the row sorts after every committed row. A taken ID fails when the write is sent.
        const row: Inserted = {
          c,
          id,
          k: st.inserted.length,
          sent: false,
          docs: [],
        };
        const doc = {
          id,
          revision: 1,
          seq: PROVISIONAL_SEQ + row.k,
          value: structuredClone(value),
        };
        row.docs.push(doc);
        st.inserted.push(row);
        st.rows.set(key, row);
        st.pending.set(key, {
          kind: 'insert',
          c,
          id,
          revision: 1,
          value: JSON.stringify(value),
          cols,
          params,
          row,
        });
        await sendUnlessBatched();
        return doc;
      },
      update: async <T>(
        c: CollectionName,
        id: string,
        expected: number,
        value: T,
      ) => {
        const { cols, params } = indexParams(c, value);
        const key = keyOf(c, id);
        const pending = st.pending.get(key);
        const known = st.known.get(key);
        if (pending || known) {
          // A row this transaction has read or written: its revision and seq are known, so the write can wait.
          const current = pending?.revision ?? known!.revision;
          if (current !== expected)
            throw staleRevision(c, id, 'revision', expected, current);
          const write = {
            revision: expected + 1,
            value: JSON.stringify(value),
            cols,
            params,
          };
          if (pending) Object.assign(pending, write);
          else
            st.pending.set(key, {
              kind: 'update',
              c,
              id,
              expected,
              ...write,
            });
          const row = st.rows.get(key);
          const doc = {
            id,
            revision: expected + 1,
            seq: row ? PROVISIONAL_SEQ + row.k : known!.seq,
            value: structuredClone(value),
          };
          row?.docs.push(doc);
          await sendUnlessBatched();
          return doc;
        }
        const sets = ['revision', 'value', ...cols].map(
          (col, i) => `${col} = $${i + 1}`,
        );
        const n = sets.length;
        const res = await db.query<{ seq: string | number }>(
          `UPDATE ${this.t(c)} SET ${sets.join(', ')} WHERE id = $${n + 1} AND revision = $${n + 2} RETURNING seq`,
          [expected + 1, JSON.stringify(value), ...params, id, expected],
        );
        if (res.rows.length !== 1) {
          const cur = await get(c, id);
          if (!cur) throw staleRevision(c, id, 'missing', expected);
          throw staleRevision(c, id, 'revision', expected, cur.revision);
        }
        return seen(c, {
          id,
          revision: expected + 1,
          seq: Number(res.rows[0]!.seq),
          value: structuredClone(value),
        });
      },
      remove: async (c, id, expected) => {
        const key = keyOf(c, id);
        if (st.pending.has(key)) await this.flush(db, st, false);
        st.known.delete(key);
        const res = await db.query(
          `DELETE FROM ${this.t(c)} WHERE id = $1 AND revision = $2`,
          [id, expected],
        );
        if (affected(res) !== 1) {
          const cur = await get(c, id);
          if (!cur) throw staleRevision(c, id, 'missing', expected);
          throw staleRevision(c, id, 'revision', expected, cur.revision);
        }
      },
      find: async <T, C extends CollectionName>(
        c: C,
        o: FindOptions<C> = {},
      ) => {
        const clauses: string[] = [];
        const params: unknown[] = [];
        const p = (v: unknown) => {
          params.push(v);
          return `$${params.length}`;
        };
        const column = (f: string, v: IndexValue) =>
          `"${typeof v === 'number' ? 'n' : 's'}_${f}"`;
        for (const [field, v] of Object.entries(o.where ?? {}) as [
          string,
          IndexValue,
        ][]) {
          allowed(c, field);
          if (v === null)
            clauses.push(`"n_${field}" IS NULL AND "s_${field}" IS NULL`);
          else clauses.push(`${column(field, v)} = ${p(v)}`);
        }
        if (o.range) {
          const f = String(o.range.field);
          allowed(c, f);
          const { gte, lte } = o.range;
          const probe = gte ?? lte;
          if (probe === undefined || probe === null)
            clauses.push(`("n_${f}" IS NOT NULL OR "s_${f}" IS NOT NULL)`);
          else {
            // Mixed-type comparisons follow the reference: numbers and strings are kept in separate columns.
            const col = column(f, probe);
            clauses.push(`${col} IS NOT NULL`);
            if (gte !== undefined && gte !== null)
              clauses.push(`${col} >= ${p(gte)}`);
            if (lte !== undefined && lte !== null)
              clauses.push(`${col} <= ${p(lte)}`);
          }
        }
        if (o.afterSeq !== undefined) clauses.push(`seq > ${p(o.afterSeq)}`);
        // Read your own writes: buffered writes to this collection are sent first.
        if ([...st.pending.values()].some((w) => w.c === c))
          await this.flush(db, st, false);
        const by = String(o.orderBy ?? 'seq');
        if (by !== 'seq') allowed(c, by);
        const order =
          by === 'seq'
            ? 'seq'
            : `"n_${by}" ASC NULLS FIRST, "s_${by}" ASC NULLS FIRST, seq`;
        const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
        const limit =
          o.limit !== undefined
            ? `LIMIT ${Math.max(0, Math.floor(o.limit))}`
            : '';
        const rows = (
          await db.query<Row>(
            `SELECT id, revision, seq, value FROM ${this.t(c)} ${where} ORDER BY ${order} ${limit}`,
            params,
          )
        ).rows;
        return rows.map((r) => seen(c, toDoc<T>(r)));
      },
    };
  }
}
