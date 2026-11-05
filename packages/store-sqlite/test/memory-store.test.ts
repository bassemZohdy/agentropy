// FEAT-016.1: the driver-neutral Store port and its in-memory reference adapter (durability "none").
import { MemoryStore } from '@agentropy/core';
import { defineStoreConformance } from '@agentropy/testkit';
import { describe, expect, it } from 'vitest';

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
