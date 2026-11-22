// TASK-068: a peer's reply is bounded while it is read (MCP, A2A client, federation cards, model responses), a stalled
// body ends with the caller's deadline, and a reply that is not JSON is a typed failure.
import type { TrustedPrincipal } from '@agentropy/core';
import { describe, expect, it } from 'vitest';
import {
  A2ACommunicationProvider,
  AgentDirectoryFederation,
  McpClient,
  mcpHttpTransport,
  openAICompatibleReasoning,
} from '../../runtime/src/index.js';
import {
  ReplyNotJson,
  ReplyTooLarge,
  readBoundedJson,
  readBoundedText,
} from '../../runtime/src/bounded-body.js';
import { code } from '../../runtime/test/harness.js';
import { FakeClock, FakePolicy } from '../src/index.js';

const caller: TrustedPrincipal = { id: 'alice', type: 'user', tenantId: 't-1' };

/** A body that never ends: it hands out 64 KiB chunks for as long as it is read, and counts what was asked of it. */
function endless() {
  const seen = { pulls: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      seen.pulls++;
      c.enqueue(new Uint8Array(64 * 1024).fill(97));
    },
    cancel() {
      seen.cancelled = true;
    },
  });
  return { body, seen };
}

/** A body that sends its headers and then nothing. */
const stalled = () =>
  new ReadableStream<Uint8Array>({ pull: () => new Promise(() => undefined) });

const json = (body: BodyInit, headers: Record<string, string> = {}) =>
  new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers },
  });

describe('bounded body reads (TASK-068)', () => {
  it('TASK-068: an over-limit reply is refused without being buffered whole', async () => {
    const e = endless();
    await expect(
      readBoundedText(json(e.body), 200 * 1024),
    ).rejects.toBeInstanceOf(ReplyTooLarge);
    expect(e.seen.pulls).toBeLessThanOrEqual(6);
    expect(e.seen.cancelled).toBe(true);

    // A declared length over the cap is refused before a byte is read.
    const declared = endless();
    await expect(
      readBoundedText(
        json(declared.body, { 'content-length': String(50 * 1024 * 1024) }),
        1024,
      ),
    ).rejects.toBeInstanceOf(ReplyTooLarge);
    expect(declared.seen.pulls).toBeLessThanOrEqual(1);
  });

  it('TASK-068: a stalled body ends with the signal, and what fits is read', async () => {
    await expect(
      readBoundedText(json(stalled()), 1024, AbortSignal.timeout(30)),
    ).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(await readBoundedText(json('{"a":1}'), 1024)).toBe('{"a":1}');
    expect(await readBoundedJson(json('{"a":1}'), 1024)).toEqual({ a: 1 });
    await expect(readBoundedJson(json('<html>'), 1024)).rejects.toBeInstanceOf(
      ReplyNotJson,
    );
  });
});

describe('every reader of a peer reply is bounded (TASK-068)', () => {
  it('TASK-068: the MCP transport refuses an endless reply', async () => {
    const e = endless();
    const client = new McpClient(
      mcpHttpTransport({
        url: 'https://mcp.example/mcp',
        maxResponseBytes: 100 * 1024,
        fetch: async (_url, init) => {
          const m = (JSON.parse(init.body) as { method: string; id?: number })
            .method;
          if (m === 'initialize')
            return json('{"jsonrpc":"2.0","id":1,"result":{}}') as never;
          if (m === 'notifications/initialized')
            return new Response(null, { status: 202 }) as never;
          return json(e.body) as never;
        },
      }),
    );
    expect(await code(client.listTools())).toBe('ProviderUnavailable');
    expect(e.seen.pulls).toBeLessThanOrEqual(4);
    expect(e.seen.cancelled).toBe(true);
  });

  it('FIX-085: the reply to an MCP notification is not read, so an endless one costs nothing', async () => {
    const e = endless();
    const client = new McpClient(
      mcpHttpTransport({
        url: 'https://mcp.example/mcp',
        maxResponseBytes: 100 * 1024,
        fetch: async (_url, init) => {
          const m = (JSON.parse(init.body) as { method: string }).method;
          if (m === 'initialize')
            return json('{"jsonrpc":"2.0","id":1,"result":{}}') as never;
          if (m === 'notifications/initialized') return json(e.body) as never;
          return json(
            '{"jsonrpc":"2.0","id":2,"result":{"tools":[]}}',
          ) as never;
        },
      }),
    );
    expect(await client.listTools()).toEqual([]);
    expect(e.seen.pulls).toBeLessThanOrEqual(2);
    expect(e.seen.cancelled).toBe(true);
  });

  it('FIX-085: an MCP error reply (401, 404, 5xx) has its body released, not left holding the connection', async () => {
    for (const status of [401, 404, 500]) {
      const e = endless();
      const client = new McpClient(
        mcpHttpTransport({
          url: 'https://mcp.example/mcp',
          fetch: async () =>
            new Response(e.body, {
              status,
              headers: { 'content-type': 'application/json' },
            }) as never,
        }),
      );
      await code(client.listTools());
      expect(e.seen.cancelled, String(status)).toBe(true);
    }
  });

  it('TASK-068: a federation card is cut off at the cap, and a stalled card body times out', async () => {
    const e = endless();
    const clock = new FakeClock('2026-11-06T00:00:00.000Z');
    const refresh = async (res: () => Response, timeoutMs?: number) => {
      const fed = new AgentDirectoryFederation({
        peers: [
          { id: 'p', cardUrl: 'https://p.example/card.json', tenants: ['t-1'] },
        ],
        fetch: async () => res() as never,
        pdp: new FakePolicy(),
        now: clock.iso,
        ...(timeoutMs ? { timeoutMs } : {}),
      });
      return (await fed.refresh())[0]!;
    };
    expect(await refresh(() => json(e.body))).toMatchObject({
      ok: false,
      error: 'SchemaViolation',
    });
    expect(e.seen.pulls).toBeLessThanOrEqual(3);
    expect(e.seen.cancelled).toBe(true);
    expect(await refresh(() => json(stalled()), 40)).toMatchObject({
      ok: false,
      error: 'RemoteUnavailable',
    });
  });

  it('TASK-068: the A2A client refuses an endless reply, a stalled one, and one that is not JSON', async () => {
    const provide = (res: () => Response) =>
      new A2ACommunicationProvider({
        allowEndpoint: (u: URL) => u.origin === 'https://peer.example',
        fetch: async () => res() as never,
        maxResponseBytes: 100 * 1024,
      });
    const ref = {
      remoteTaskId: 'r-1',
      route: {
        target: {
          definitionId: 'w',
          version: '1.0.0',
          tenantId: 't-1',
          endpoint: 'https://peer.example/a2a',
        },
      },
    } as never;
    const ctx = (signal?: AbortSignal) =>
      ({
        caller,
        correlationId: 'c',
        ...(signal ? { signal } : {}),
      }) as never;
    const e = endless();
    expect(await code(provide(() => json(e.body)).getTask(ref, ctx()))).toBe(
      'RemoteUnavailable',
    );
    expect(e.seen.pulls).toBeLessThanOrEqual(4);
    expect(e.seen.cancelled).toBe(true);
    expect(
      await code(
        provide(() => json('<html>not json</html>')).getTask(ref, ctx()),
      ),
    ).toBe('RemoteUnavailable');
    expect(
      await code(
        provide(() => json(stalled())).getTask(
          ref,
          ctx(AbortSignal.timeout(40)),
        ),
      ),
    ).toBe('RemoteUnavailable');
  });

  it('TASK-068: a model reply is cut off at the cap, and the timeout covers a stalled body', async () => {
    const e = endless();
    const complete = (res: () => Response, timeoutMs?: number) =>
      openAICompatibleReasoning({
        baseUrl: 'https://model.example/v1',
        model: 'm',
        fetch: async () => res() as never,
        maxResponseBytes: 100 * 1024,
        ...(timeoutMs ? { timeoutMs } : {}),
      }).complete(
        { messages: [{ role: 'user', content: 'hi' }], maxTokens: 10 } as never,
        { tenantId: 't-1', signal: new AbortController().signal } as never,
      );
    expect(await code(complete(() => json(e.body)))).toBe(
      'ProviderUnavailable',
    );
    expect(e.seen.pulls).toBeLessThanOrEqual(4);
    expect(e.seen.cancelled).toBe(true);
    expect(await code(complete(() => json(stalled()), 40))).toBe('Timeout');
  });
});
