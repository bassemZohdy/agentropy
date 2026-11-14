// FEAT-016.1: the driver-neutral Store port and its in-memory reference adapter (durability "none").
import { MemoryStore } from '@agentropy/core';
import { defineStoreConformance } from '@agentropy/testkit';
import { describe, expect, it, vi } from 'vitest';

defineStoreConformance({ describe, it, expect }, 'memory', {
  create: async () => new MemoryStore(),
});

describe('MemoryStore', () => {
  it('declares durability none and refuses use after close', async () => {
    const s = new MemoryStore();
    expect(s.durability).toBe('none');
    await s.close();
    await expect(s.transaction(async () => 1)).rejects.toMatchObject({
      code: 'ProviderUnavailable',
    });
  });
});

describe('MemoryStore rollback (TASK-069)', () => {
  it('TASK-069: a transaction on a large store copies only the documents it touches', async () => {
    const s = new MemoryStore();
    await s.transaction(async (tx) => {
      for (let i = 0; i < 500; i++)
        await tx.insert('sessions', `s-${i}`, { tenantId: 't', n: i });
    });
    const real = structuredClone;
    let cloned = 0;
    const spy = vi.spyOn(globalThis, 'structuredClone').mockImplementation(((
      v: unknown,
    ) => {
      // The documents in what is being copied: a whole store is a map of maps.
      cloned +=
        v instanceof Map
          ? [...v.values()].reduce(
              (n: number, m) => n + (m instanceof Map ? m.size : 1),
              0,
            )
          : 1;
      return real(v);
    }) as typeof structuredClone);
    try {
      await s.transaction(async (tx) => {
        const doc = (await tx.get<{ n: number }>('sessions', 's-7'))!;
        await tx.update('sessions', 's-7', doc.revision, {
          tenantId: 't',
          n: 70,
        });
      });
    } finally {
      spy.mockRestore();
    }
    expect(cloned).toBeLessThan(10);
  });

  it('TASK-069: a failed transaction undoes inserts, updates and removes, and the sequence', async () => {
    const s = new MemoryStore();
    await s.transaction(async (tx) => {
      await tx.insert('sessions', 'keep', { tenantId: 't', n: 1 });
      await tx.insert('sessions', 'gone', { tenantId: 't', n: 2 });
    });
    const before = await s.transaction((tx) =>
      tx.find('sessions', { orderBy: 'seq' }),
    );
    await expect(
      s.transaction(async (tx) => {
        await tx.insert('sessions', 'new', { tenantId: 't', n: 3 });
        const keep = (await tx.get<{ n: number }>('sessions', 'keep'))!;
        await tx.update('sessions', 'keep', keep.revision, {
          tenantId: 't',
          n: 10,
        });
        const second = (await tx.get('sessions', 'keep'))!;
        await tx.update('sessions', 'keep', second.revision, {
          tenantId: 't',
          n: 11,
        });
        const gone = (await tx.get('sessions', 'gone'))!;
        await tx.remove('sessions', 'gone', gone.revision);
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');
    expect(
      await s.transaction((tx) => tx.find('sessions', { orderBy: 'seq' })),
    ).toEqual(before);
    // The sequence went back too: the next insert gets the number the failed one had taken.
    const next = await s.transaction((tx) =>
      tx.insert('sessions', 'later', { tenantId: 't', n: 4 }),
    );
    expect(next.seq).toBe(Math.max(...before.map((d) => d.seq)) + 1);
  });
});
