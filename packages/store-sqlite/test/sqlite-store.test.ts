// FEAT-016.2: node:sqlite adapter — Store conformance, durable reopen, and a real process crash mid-transaction.
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import type { Store } from '@agentropy/core';
import { defineStoreConformance } from '@agentropy/testkit';
import { describe, expect, it } from 'vitest';
import { SqliteStore } from '../src/index.js';

const paths = new WeakMap<Store, string>();
async function fileStore(): Promise<Store> {
  const path = join(
    await mkdtemp(join(tmpdir(), 'agentropy-sqlite-')),
    'store.db',
  );
  const s = new SqliteStore({ path });
  paths.set(s, path);
  return s;
}

defineStoreConformance({ describe, it, expect }, 'sqlite (file)', {
  create: fileStore,
  reopen: async (s) => {
    const path = paths.get(s)!;
    await s.close();
    return new SqliteStore({ path });
  },
});

defineStoreConformance({ describe, it, expect }, 'sqlite (:memory:)', {
  create: async () => new SqliteStore({ path: ':memory:' }),
});

describe('SqliteStore', () => {
  it('declares durable-execution for files and none for :memory:', async () => {
    const f = await fileStore();
    expect(f.durability).toBe('durable-execution');
    expect(new SqliteStore({ path: ':memory:' }).durability).toBe('none');
    await f.close();
  });

  it('uses WAL with synchronous FULL', async () => {
    const s = await fileStore();
    await s.close();
    const db = new DatabaseSync(paths.get(s)!);
    expect(
      (db.prepare('PRAGMA journal_mode').get() as { journal_mode: string })
        .journal_mode,
    ).toBe('wal');
    db.close();
  });

  it('a process killed mid-transaction loses only the uncommitted work', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentropy-crash-'));
    const path = join(dir, 'store.db');
    const script = join(dir, 'crash.mjs');
    const adapter = pathToFileURL(
      join(process.cwd(), 'packages/store-sqlite/dist/index.js'),
    ).href;
    await writeFile(
      script,
      `import { SqliteStore } from ${JSON.stringify(adapter)};
const s = new SqliteStore({ path: process.argv[2] });
await s.transaction((tx) => tx.insert('outbox', 'committed', { published: 0 }));
await s.transaction(async (tx) => {
  await tx.insert('outbox', 'uncommitted', { published: 0 });
  await tx.insert('tasks', 't1', { status: 'running' });
  process.exit(137);
});`,
    );
    const child = spawnSync(process.execPath, [script, path], {
      encoding: 'utf8',
    });
    expect(child.status).toBe(137);
    const s = new SqliteStore({ path });
    const ids = (await s.transaction((tx) => tx.find('outbox', {}))).map(
      (d) => d.id,
    );
    expect(ids).toEqual(['committed']);
    expect(await s.transaction((tx) => tx.get('tasks', 't1'))).toBeUndefined();
    await s.close();
  });

  it('refuses a database written by a newer schema version', async () => {
    const s = await fileStore();
    await s.close();
    const db = new DatabaseSync(paths.get(s)!);
    db.exec('INSERT INTO schema_migrations (version) VALUES (99)');
    db.close();
    expect(() => new SqliteStore({ path: paths.get(s)! })).toThrowError(
      /newer than this adapter/,
    );
  });

  it('rejects queries on non-indexed fields', async () => {
    const s = new SqliteStore({ path: ':memory:' });
    await expect(
      s.transaction((tx) =>
        tx.find('tasks', { where: { secret: 'x' } as never }),
      ),
    ).rejects.toMatchObject({ code: 'Internal' });
    await s.close();
  });
});
