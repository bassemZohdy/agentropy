/** @agentropy/store-sqlite — Store port adapter on the built-in node:sqlite module (ADR-0017, ADR-0027). */
import {
  DatabaseSync,
  type SQLInputValue,
  type StatementSync,
} from 'node:sqlite';
import {
  AgentropyError,
  AsyncMutex,
  STORE_COLLECTIONS,
  indexValues,
  staleRevision,
  type CollectionName,
  type FindOptions,
  type Store,
  type StoreTx,
  type StoredDocument,
} from '@agentropy/core';

export const packageName = '@agentropy/store-sqlite' as const;

const SCHEMA_VERSION = 1;
const table = (c: CollectionName) => `"c_${c}"`;
const col = (field: string) => `"i_${field}"`;

function migrate(db: DatabaseSync): void {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY)',
  );
  db.exec(
    'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL)',
  );
  db.exec("INSERT OR IGNORE INTO meta (key, value) VALUES ('seq', 0)");
  const applied = db
    .prepare('SELECT MAX(version) AS v FROM schema_migrations')
    .get() as { v: number | null };
  if ((applied.v ?? 0) > SCHEMA_VERSION) {
    throw new AgentropyError(
      'IncompatibleVersion',
      `Database schema ${applied.v} is newer than this adapter (${SCHEMA_VERSION})`,
      { details: { kind: 'store-schema' } },
    );
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const [c, fields] of Object.entries(STORE_COLLECTIONS) as [
      CollectionName,
      readonly string[],
    ][]) {
      const indexCols = fields.map((f) => `${col(f)}`).join(', ');
      db.exec(
        `CREATE TABLE IF NOT EXISTS ${table(c)} (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, seq INTEGER NOT NULL, value TEXT NOT NULL${indexCols ? `, ${indexCols}` : ''})`,
      );
      evolve(db, c, fields);
      db.exec(`CREATE INDEX IF NOT EXISTS "x_${c}_seq" ON ${table(c)} (seq)`);
      for (const f of fields)
        db.exec(
          `CREATE INDEX IF NOT EXISTS "x_${c}_${f}" ON ${table(c)} (${col(f)}, seq)`,
        );
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  db.exec(
    `INSERT OR IGNORE INTO schema_migrations (version) VALUES (${SCHEMA_VERSION})`,
  );
}

/**
 * Additive schema evolution (FEAT-028.3): an index field added to an existing collection gets its column, and the
 * column is backfilled from the stored JSON, so a database written by an older release keeps answering queries.
 */
function evolve(
  db: DatabaseSync,
  c: CollectionName,
  fields: readonly string[],
): void {
  const have = new Set(
    (
      db.prepare(`PRAGMA table_info(${table(c)})`).all() as { name: string }[]
    ).map((r) => r.name),
  );
  const missing = fields.filter((f) => !have.has(`i_${f}`));
  if (!missing.length) return;
  for (const f of missing)
    db.exec(`ALTER TABLE ${table(c)} ADD COLUMN ${col(f)}`);
  const update = db.prepare(
    `UPDATE ${table(c)} SET ${missing.map((f) => `${col(f)} = ?`).join(', ')} WHERE id = ?`,
  );
  for (const r of db
    .prepare(`SELECT id, value FROM ${table(c)}`)
    .all() as unknown as { id: string; value: string }[]) {
    const idx = indexValues(c, JSON.parse(r.value));
    update.run(...missing.map((f) => idx[f] as SQLInputValue), r.id);
  }
}

interface Row {
  id: string;
  revision: number;
  seq: number;
  value: string;
}

const toDoc = <T>(r: Row): StoredDocument<T> => ({
  id: r.id,
  revision: r.revision,
  seq: r.seq,
  value: JSON.parse(r.value) as T,
});

export interface SqliteStoreOptions {
  /** File path, or ":memory:" (then durability is "none"). */
  path: string;
}

/**
 * Single-process SQLite store in WAL mode with synchronous=FULL. One `transaction` = one
 * `BEGIN IMMEDIATE … COMMIT`; transactions are serialized by an in-process mutex. Not HA (ADR-0017).
 */
export class SqliteStore implements Store {
  readonly durability: Store['durability'];
  private readonly db: DatabaseSync;
  private readonly mutex = new AsyncMutex();
  private closed = false;

  constructor(options: SqliteStoreOptions) {
    this.db = new DatabaseSync(options.path);
    this.durability =
      options.path === ':memory:' ? 'none' : 'durable-execution';
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = FULL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    // The WAL file shrinks back after a burst of writes instead of staying at its high-water mark.
    this.db.exec('PRAGMA journal_size_limit = 67108864');
    migrate(this.db);
  }

  transaction<T>(fn: (tx: StoreTx) => Promise<T>): Promise<T> {
    return this.mutex.run(async () => {
      if (this.closed)
        throw new AgentropyError('ProviderUnavailable', 'Store is closed');
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const result = await fn(this.tx());
        this.db.exec('COMMIT');
        return result;
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
    });
  }

  async close(): Promise<void> {
    await this.mutex.run(async () => {
      if (!this.closed) {
        this.closed = true;
        this.statements.clear();
        this.db.close();
      }
    });
  }

  /** Prepared statements by SQL text: the SQL varies only by collection and filter shape, so the set stays small. */
  private readonly statements = new Map<string, StatementSync>();
  private prep(sql: string): StatementSync {
    let st = this.statements.get(sql);
    if (!st) {
      if (this.statements.size >= 512) this.statements.clear();
      this.statements.set(sql, (st = this.db.prepare(sql)));
    }
    return st;
  }

  private nextSeq(): number {
    return (
      this.prep(
        "UPDATE meta SET value = value + 1 WHERE key = 'seq' RETURNING value",
      ).get() as { value: number }
    ).value;
  }

  private tx(): StoreTx {
    const get = <T>(c: CollectionName, id: string) => {
      const r = this.prep(
        `SELECT id, revision, seq, value FROM ${table(c)} WHERE id = ?`,
      ).get(id) as Row | undefined;
      return r ? toDoc<T>(r) : undefined;
    };
    const write = (
      c: CollectionName,
      id: string,
      revision: number,
      seq: number,
      value: unknown,
      insert: boolean,
    ) => {
      const idx = indexValues(c, value);
      const fields = Object.keys(idx);
      const json = JSON.stringify(value);
      if (insert) {
        const cols = [
          'id',
          'revision',
          'seq',
          'value',
          ...fields.map(col),
        ].join(', ');
        this.prep(
          `INSERT INTO ${table(c)} (${cols}) VALUES (${['?', '?', '?', '?', ...fields.map(() => '?')].join(', ')})`,
        ).run(
          id,
          revision,
          seq,
          json,
          ...(Object.values(idx) as SQLInputValue[]),
        );
      } else {
        const sets = [
          'revision = ?',
          'value = ?',
          ...fields.map((f) => `${col(f)} = ?`),
        ].join(', ');
        this.prep(`UPDATE ${table(c)} SET ${sets} WHERE id = ?`).run(
          revision,
          json,
          ...(Object.values(idx) as SQLInputValue[]),
          id,
        );
      }
    };
    return {
      get: async (c, id) => get(c, id),
      insert: async <T>(c: CollectionName, id: string, value: T) => {
        if (get(c, id)) throw staleRevision(c, id, 'exists');
        indexValues(c, value);
        const seq = this.nextSeq();
        write(c, id, 1, seq, value, true);
        return { id, revision: 1, seq, value: structuredClone(value) };
      },
      update: async <T>(
        c: CollectionName,
        id: string,
        expected: number,
        value: T,
      ) => {
        const cur = get(c, id);
        if (!cur) throw staleRevision(c, id, 'missing', expected);
        if (cur.revision !== expected)
          throw staleRevision(c, id, 'revision', expected, cur.revision);
        write(c, id, expected + 1, cur.seq, value, false);
        return {
          id,
          revision: expected + 1,
          seq: cur.seq,
          value: structuredClone(value),
        };
      },
      remove: async (c, id, expected) => {
        const cur = get(c, id);
        if (!cur) throw staleRevision(c, id, 'missing', expected);
        if (cur.revision !== expected)
          throw staleRevision(c, id, 'revision', expected, cur.revision);
        this.prep(`DELETE FROM ${table(c)} WHERE id = ?`).run(id);
      },
      find: async <T, C extends CollectionName>(
        c: C,
        o: FindOptions<C> = {},
      ) => {
        const allowed = new Set<string>(STORE_COLLECTIONS[c]);
        const clauses: string[] = [];
        const params: SQLInputValue[] = [];
        for (const [field, v] of Object.entries(o.where ?? {}) as [
          string,
          string | number | null,
        ][]) {
          if (!allowed.has(field))
            throw new AgentropyError(
              'Internal',
              `${c}.${field} is not indexed`,
            );
          if (v === null) clauses.push(`${col(field)} IS NULL`);
          else {
            clauses.push(`${col(field)} = ?`);
            params.push(v);
          }
        }
        if (o.range) {
          const f = String(o.range.field);
          if (!allowed.has(f))
            throw new AgentropyError('Internal', `${c}.${f} is not indexed`);
          clauses.push(`${col(f)} IS NOT NULL`);
          if (o.range.gte !== undefined && o.range.gte !== null) {
            clauses.push(`${col(f)} >= ?`);
            params.push(o.range.gte);
          }
          if (o.range.lte !== undefined && o.range.lte !== null) {
            clauses.push(`${col(f)} <= ?`);
            params.push(o.range.lte);
          }
        }
        if (o.afterSeq !== undefined) {
          clauses.push('seq > ?');
          params.push(o.afterSeq);
        }
        const by = o.orderBy ?? 'seq';
        if (by !== 'seq' && !allowed.has(String(by)))
          throw new AgentropyError(
            'Internal',
            `${c}.${String(by)} is not indexed`,
          );
        const order = by === 'seq' ? 'seq' : `${col(String(by))}, seq`;
        const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
        const limit =
          o.limit !== undefined
            ? `LIMIT ${Math.max(0, Math.floor(o.limit))}`
            : '';
        const rows = this.prep(
          `SELECT id, revision, seq, value FROM ${table(c)} ${where} ORDER BY ${order} ${limit}`,
        ).all(...params) as unknown as Row[];
        return rows.map((r) => toDoc<T>(r));
      },
    };
  }
}
