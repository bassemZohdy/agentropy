/**
 * Reference `memory` capability provider (FEAT-045; Capability v1 revision 14, "Memory provider"): `remember` and
 * `recall` on the Store port.
 *
 * - **Scoped.** An entry belongs to a tenant and to the acting principal of the invocation (an agent's instance
 *   identity), so another tenant, or another agent in the same tenant, never reads or overwrites it.
 * - **Bounded.** Key, text (8 KiB), tags, TTL and the number of live entries per scope (`maxEntries`, default 1,000)
 *   are validated; recall returns at most 20 entries.
 * - **Retained.** An entry expires after its TTL (or the provider's `defaultTtlMs`); it is invisible at once and
 *   `compact()` removes it. There is no `forget` operation in v1.
 * - **Plain matching.** Key, tag and a case-insensitive substring of the text: deterministic, newest first. A semantic
 *   provider is a different provider of the same capability. Recalled text is data written by earlier tasks and may
 *   carry instructions aimed at a model: callers treat it as untrusted.
 */
import {
  AgentropyError,
  type CapabilityInvocationContext,
  type Store,
} from '@agentropy/core';

export interface MemoryOptions {
  /** Live entries per tenant and principal (default 1,000); a new key beyond it is `QuotaExceeded`. */
  maxEntries?: number;
  /** TTL for entries that give none, in milliseconds (default: durable). */
  defaultTtlMs?: number;
}

interface MemoryRow {
  tenantId: string;
  ownerId: string;
  key: string;
  text: string;
  tags: string[];
  rememberedAt: string;
  expiresAt?: string;
}

const KEY = /^[A-Za-z0-9._:/-]{1,128}$/;
const TAG = /^[a-z0-9._:-]{1,64}$/;
const MAX_TEXT_BYTES = 8 * 1024;
const MAX_TAGS = 8;
const MAX_QUERY = 256;
const DEFAULT_MAX_ENTRIES = 1_000;
const RECALL_DEFAULT = 5;
const RECALL_MAX = 20;

const bad = (message: string) => new AgentropyError('SchemaViolation', message);
const isLive = (r: MemoryRow, now: string) =>
  r.expiresAt === undefined || r.expiresAt > now;
const rowId = (tenantId: string, ownerId: string, key: string) =>
  JSON.stringify([tenantId, ownerId, key]);

export function memoryOperationHandlers(
  o: MemoryOptions & { store: Store; now: () => string },
): Record<
  string,
  (input: unknown, ctx: CapabilityInvocationContext) => Promise<unknown>
> {
  const maxEntries = o.maxEntries ?? DEFAULT_MAX_ENTRIES;
  if (!Number.isInteger(maxEntries) || maxEntries < 1)
    throw new AgentropyError(
      'InvalidConfiguration',
      'memory.maxEntries must be a positive integer',
    );
  if (
    o.defaultTtlMs !== undefined &&
    (!Number.isSafeInteger(o.defaultTtlMs) || o.defaultTtlMs < 1)
  )
    throw new AgentropyError(
      'InvalidConfiguration',
      'memory.defaultTtlMs must be a positive integer',
    );
  return {
    remember: async (raw, ctx) => {
      const i = (raw ?? {}) as Record<string, unknown>;
      const key = i['key'] ?? (ctx.stepKey ? `step:${ctx.stepKey}` : undefined);
      if (typeof key !== 'string' || !KEY.test(key))
        throw bad(
          i['key'] === undefined
            ? 'memory.remember needs a key or a step key'
            : 'key must be 1 to 128 characters of A-Z a-z 0-9 . _ : / -',
        );
      const text = i['text'];
      if (
        typeof text !== 'string' ||
        !text ||
        Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES
      )
        throw bad(
          `text must be a non-empty string of at most ${MAX_TEXT_BYTES} bytes`,
        );
      const tagsIn = i['tags'] ?? [];
      if (
        !Array.isArray(tagsIn) ||
        tagsIn.length > MAX_TAGS ||
        tagsIn.some((t) => typeof t !== 'string' || !TAG.test(t))
      )
        throw bad(
          `tags must be at most ${MAX_TAGS} strings of 1 to 64 characters of a-z 0-9 . _ : -`,
        );
      const tags = [...new Set(tagsIn as string[])];
      const ttl = i['ttlMs'] ?? o.defaultTtlMs;
      if (
        ttl !== undefined &&
        (!Number.isSafeInteger(ttl) || (ttl as number) < 1)
      )
        throw bad('ttlMs must be a positive integer');
      const now = o.now();
      let expiresAt: string | undefined;
      if (ttl !== undefined) {
        const at = new Date(Date.parse(now) + (ttl as number));
        if (Number.isNaN(at.getTime())) throw bad('ttlMs is too large');
        expiresAt = at.toISOString();
      }
      const id = rowId(ctx.tenantId, ctx.principalId, key);
      return o.store.transaction(async (tx) => {
        const existing = await tx.get<MemoryRow>('memories', id);
        const replaced = !!existing && isLive(existing.value, now);
        if (!replaced) {
          const live = (
            await tx.find<MemoryRow>('memories', {
              where: { tenantId: ctx.tenantId, ownerId: ctx.principalId },
            })
          ).filter((d) => isLive(d.value, now)).length;
          if (live >= maxEntries)
            throw new AgentropyError(
              'QuotaExceeded',
              'The memory of this agent is full',
              { details: { maxEntries } },
            );
        }
        const value: MemoryRow = {
          tenantId: ctx.tenantId,
          ownerId: ctx.principalId,
          key,
          text,
          tags,
          rememberedAt: now,
          ...(expiresAt ? { expiresAt } : {}),
        };
        if (existing) await tx.update('memories', id, existing.revision, value);
        else await tx.insert('memories', id, value);
        return { key, replaced };
      });
    },
    recall: async (raw, ctx) => {
      const i = (raw ?? {}) as Record<string, unknown>;
      const limit = i['limit'] ?? RECALL_DEFAULT;
      if (
        !Number.isInteger(limit) ||
        (limit as number) < 1 ||
        (limit as number) > RECALL_MAX
      )
        throw bad(`limit must be an integer from 1 to ${RECALL_MAX}`);
      for (const f of ['key', 'tag', 'query'])
        if (i[f] !== undefined && typeof i[f] !== 'string')
          throw bad(`${f} must be a string`);
      const query = i['query'] as string | undefined;
      if (query !== undefined && (!query || query.length > MAX_QUERY))
        throw bad(`query must be 1 to ${MAX_QUERY} characters`);
      const needle = query?.toLowerCase();
      const now = o.now();
      const rows = await o.store.transaction((tx) =>
        tx.find<MemoryRow>('memories', {
          where: { tenantId: ctx.tenantId, ownerId: ctx.principalId },
        }),
      );
      const entries = rows
        .map((d) => d.value)
        .filter(
          (r) =>
            isLive(r, now) &&
            (i['key'] === undefined || r.key === i['key']) &&
            (i['tag'] === undefined || r.tags.includes(i['tag'] as string)) &&
            (needle === undefined || r.text.toLowerCase().includes(needle)),
        )
        .sort((a, b) =>
          a.rememberedAt !== b.rememberedAt
            ? a.rememberedAt < b.rememberedAt
              ? 1
              : -1
            : a.key < b.key
              ? -1
              : 1,
        )
        .slice(0, limit as number)
        .map((r) => ({
          key: r.key,
          text: r.text,
          tags: r.tags,
          rememberedAt: r.rememberedAt,
          ...(r.expiresAt ? { expiresAt: r.expiresAt } : {}),
        }));
      return { entries };
    },
  };
}
