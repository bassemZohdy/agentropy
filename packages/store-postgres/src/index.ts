/**
 * @agentropy/store-postgres — Store port adapter for PostgreSQL (ADR-0017, ADR-0028).
 *
 * Driver-neutral: the adapter talks to a {@link PgPool} (node-postgres `Pool` fits as-is) or to a single
 * {@link PgClient} connection (embedded PGlite fits as-is), so Agentropy carries no database driver dependency.
 *
 * Semantics, matching the SQLite adapter and the Store conformance suite:
 * - one `transaction` = one `BEGIN ISOLATION LEVEL SERIALIZABLE … COMMIT`; a serialization failure or deadlock
 *   re-runs the callback (bounded), so transaction callbacks must only touch the store;
 * - `seq` comes from a counter row updated inside the transaction, so seq order equals commit order and readers
 *   paging with `afterSeq` never skip a row that commits late;
 * - indexed fields live in typed side columns (`n_<field>` numeric, `s_<field>` text in "C" collation) so equality,
 *   ranges and ordering behave exactly like the in-memory reference (nulls first, code-unit string order).
 */
import {
  AgentropyError,
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
} from '@agentropy/core';

export const packageName = '@agentropy/store-postgres' as const;

/** Schema version this adapter writes; a newer database is refused with IncompatibleVersion. */
export const SCHEMA_VERSION = 1;

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
  /** Close the pool/client when the store closes. Default false (the caller owns the connection). */
  ownsConnection?: boolean;
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
          await db.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
          try {
            const result = await fn(this.tx(db));
            await db.query('COMMIT');
            return result;
          } catch (err) {
            await db.query('ROLLBACK').catch(() => undefined);
            throw err;
          }
        });
      } catch (err) {
        if (err instanceof AgentropyError) throw err;
        const code = pgCode(err);
        if (!code || !SQLSTATE.test(code)) throw err;
        if (!RETRYABLE.has(code)) throw fromSqlState(code);
        if (attempt >= this.maxRetries)
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

  private tx(db: PgClient): StoreTx {
    const s = `"${this.schema}"`;
    const get = async <T>(c: CollectionName, id: string) => {
      const r = (
        await db.query<Row>(
          `SELECT id, revision, seq, value FROM ${this.t(c)} WHERE id = $1`,
          [id],
        )
      ).rows[0];
      return r ? toDoc<T>(r) : undefined;
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
        if (await get(c, id)) throw staleRevision(c, id, 'exists');
        const seq = Number(
          (
            await db.query<{ value: string | number }>(
              `UPDATE ${s}.meta SET value = value + 1 WHERE key = 'seq' RETURNING value`,
            )
          ).rows[0]!.value,
        );
        const all = ['id', 'revision', 'seq', 'value', ...cols];
        const res = await db.query(
          `INSERT INTO ${this.t(c)} (${all.join(', ')}) VALUES (${all.map((_, i) => `$${i + 1}`).join(', ')}) ON CONFLICT (id) DO NOTHING`,
          [id, 1, seq, JSON.stringify(value), ...params],
        );
        if (affected(res) !== 1) throw staleRevision(c, id, 'exists');
        return { id, revision: 1, seq, value: structuredClone(value) };
      },
      update: async <T>(
        c: CollectionName,
        id: string,
        expected: number,
        value: T,
      ) => {
        const { cols, params } = indexParams(c, value);
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
        return {
          id,
          revision: expected + 1,
          seq: Number(res.rows[0]!.seq),
          value: structuredClone(value),
        };
      },
      remove: async (c, id, expected) => {
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
        return rows.map((r) => toDoc<T>(r));
      },
    };
  }
}
