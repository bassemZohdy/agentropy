// FEAT-035.1: MCP client tool provider — discovery to Tool v1, calls under the executor's PEP and audit, schema-drift
// pinning, error handling and the Streamable HTTP transport. Offline: a fake MCP server replaces the network.
import {
  BUILTIN_PROFILES,
  type ToolInvocationContext,
  type TrustedPrincipal,
} from '@agentropy/core';
import { FakeAudit, FakePolicy } from '@agentropy/testkit';
import { describe, expect, it } from 'vitest';
import { createLocalApp } from '../src/app.js';
import {
  McpClient,
  McpToolProvider,
  mcpHttpTransport,
  mcpToolRegistration,
  type McpFetch,
  type McpTool,
  type McpTransport,
} from '../src/mcp.js';
import {
  DefaultToolExecutor,
  InMemoryToolRegistry,
  ToolProviderRegistry,
} from '../src/tools.js';
import { code, sqliteTempStore } from './harness.js';

const alice: TrustedPrincipal = { id: 'alice', type: 'user', tenantId: 't-1' };

const weather: McpTool = {
  name: 'get_weather',
  description: 'Current weather for a city',
  inputSchema: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
  },
  outputSchema: {
    type: 'object',
    properties: { temp: { type: 'number' } },
    required: ['temp'],
  },
  annotations: { readOnlyHint: true },
};
const email: McpTool = {
  name: 'Send Email!',
  description: 'Sends an email',
  inputSchema: {
    type: 'object',
    properties: { to: { type: 'string' } },
    required: ['to'],
  },
};

/** A fake MCP server behind the transport port; records what it was asked. */
function fakeServer(initial: McpTool[] = [weather, email]) {
  const seen: { method: string; params: unknown }[] = [];
  const state = {
    tools: initial,
    error: false,
    delayUntil: undefined as Promise<void> | undefined,
  };
  const transport: McpTransport = {
    async request(method, params, options) {
      seen.push({ method, params });
      if (method === 'initialize') return { protocolVersion: '2025-06-18' };
      if (method === 'tools/list') return { tools: state.tools };
      if (method === 'tools/call') {
        if (state.delayUntil) await state.delayUntil;
        options.signal?.throwIfAborted();
        const p = params as { name: string; arguments: Record<string, string> };
        if (state.error)
          return {
            isError: true,
            content: [{ type: 'text', text: 'secret-detail' }],
          };
        return p.name === 'get_weather'
          ? { structuredContent: { temp: 21 }, content: [] }
          : {
              content: [{ type: 'text', text: `sent to ${p.arguments['to']}` }],
            };
      }
      throw new Error(`unexpected ${method}`);
    },
    async notify(method, params) {
      seen.push({ method, params });
    },
  };
  return { transport, seen, state };
}

describe('discovery', () => {
  it('maps MCP tools to Tool v1: read-only is read, anything else external and at-least-once; the binding pins the schemas', async () => {
    const s = fakeServer();
    const tools = await new McpClient(s.transport).listTools();
    expect(tools.map((t) => t.name)).toEqual(['get_weather', 'Send Email!']);
    const [w, e] = tools.map((t) =>
      mcpToolRegistration(t, { idPrefix: 'Acme', version: '1.0.0' }),
    );
    expect(w!.descriptor).toMatchObject({
      id: 'acme.get_weather',
      effect: 'read',
      idempotency: 'idempotent',
      permission: 'tool:acme.get_weather:call',
    });
    expect(e!.descriptor).toMatchObject({
      id: 'acme.send-email',
      effect: 'external',
      idempotency: 'at-least-once',
    });
    expect(w!.binding).toMatchObject({
      providerId: 'mcp',
      config: { tool: 'get_weather' },
    });
    expect(w!.binding.config['schemaDigest']).toMatch(/^sha256:/);
    // The handshake ran once before the first list.
    expect(s.seen.map((x) => x.method).slice(0, 3)).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/list',
    ]);
  });
});

describe('calls through the executor', () => {
  async function setup(server = fakeServer()) {
    const pdp = new FakePolicy();
    const audit = new FakeAudit();
    const now = () => '2026-11-07T00:00:00.000Z';
    const registry = new InMemoryToolRegistry({ pdp, audit, now }, () => true);
    const providers = new ToolProviderRegistry();
    const provider = new McpToolProvider(new McpClient(server.transport), {
      schemaTtlMs: 0,
    });
    providers.register(provider);
    const admin: TrustedPrincipal = {
      id: 'admin',
      type: 'user',
      tenantId: 't-1',
    };
    const ids: string[] = [];
    for (const t of await new McpClient(server.transport).listTools()) {
      const { descriptor, binding } = mcpToolRegistration(t, {
        idPrefix: 'acme',
        version: '1.0.0',
      });
      await registry.register(
        descriptor,
        [binding],
        { publisher: 'acme', source: 'mcp' },
        admin,
      );
      await registry.activate({ id: descriptor.id, version: '1.0.0' }, admin);
      ids.push(descriptor.id);
    }
    const app = createLocalApp({
      store: sqliteTempStore(),
      pdp,
      audit,
      now,
      profiles: BUILTIN_PROFILES,
      tools: {
        registry,
        providers,
        executor: new DefaultToolExecutor({
          pdp,
          audit,
          now,
          registry,
          providers,
        }),
      },
    });
    return { app, audit, provider, registry, ids };
  }

  it('an agent calls a read tool and an effectful one; arguments reach the server, results come back, the call is audited', async () => {
    const server = fakeServer();
    const s = await setup(server);
    s.app.define(
      {
        id: 'caller',
        version: '1.0.0',
        displayName: 'caller',
        profile: { id: 'task', version: '1.0.0' },
        implementation: {
          providerId: 'native-ts',
          providerVersion: '1.0.0',
          artifact: { id: 'caller', version: '1.0.0' },
        },
        inputSchema: true,
        runtimeRequirements: { guarantees: [] },
        policyRef: { id: 'default', version: '1.0.0' },
        capabilities: [{ id: 'tool-use', versionRange: '^1.0.0' }],
        tools: s.ids.map((id) => ({ id, versionRange: '^1.0.0' })),
      },
      {
        handle: async (_inv, ctx) => {
          const w = await ctx.capabilities.invoke(
            'tool-use',
            'call',
            { toolId: 'acme.get_weather', input: { city: 'Oslo' } },
            { stepKey: 'weather' },
          );
          const e = await ctx.capabilities.invoke(
            'tool-use',
            'call',
            { toolId: 'acme.send-email', input: { to: 'bob@example.com' } },
            { stepKey: 'mail' },
          );
          return { kind: 'completed', output: { w, e } };
        },
      },
    );
    const inst = await s.app.createInstance(
      {
        definition: { id: 'caller', version: '1.0.0' },
        ownerId: 'alice',
        idempotencyKey: 'i',
      },
      alice,
    );
    const t = await s.app.delegate(
      {
        target: { instanceId: inst.id },
        input: {},
        idempotencyKey: 'k',
        correlationId: 'k',
      },
      alice,
    );
    await s.app.runUntilIdle();
    expect(await s.app.getResult(t.taskId, alice)).toEqual({
      w: { output: { temp: 21 } },
      e: { output: { text: 'sent to bob@example.com' } },
    });
    const calls = server.seen.filter((x) => x.method === 'tools/call');
    expect(calls.map((c) => c.params)).toEqual([
      { name: 'get_weather', arguments: { city: 'Oslo' } },
      { name: 'Send Email!', arguments: { to: 'bob@example.com' } },
    ]);
    expect(s.audit.events.filter((e) => e.type === 'tool.invoke')).toHaveLength(
      2,
    );
  });

  it('a server that changed a tool’s schema after registration is refused with IncompatibleVersion, not called', async () => {
    const server = fakeServer();
    const s = await setup(server);
    server.state.tools = [
      {
        ...weather,
        inputSchema: {
          type: 'object',
          properties: { town: { type: 'string' } },
        },
      },
      email,
    ];
    const record = s.registry.get({
      id: 'acme.get_weather',
      version: '1.0.0',
    })!;
    const ctx = {
      tenantId: 't-1',
      taskId: 'task',
      executionId: 'x',
      principal: alice,
      signal: new AbortController().signal,
    } as ToolInvocationContext;
    const before = server.seen.filter((x) => x.method === 'tools/call').length;
    expect(
      await code(
        s.provider.invoke(
          record.bindings[0]!,
          record.descriptor,
          { city: 'Oslo' },
          ctx,
        ),
      ),
    ).toBe('IncompatibleVersion');
    expect(server.seen.filter((x) => x.method === 'tools/call')).toHaveLength(
      before,
    );
    // A tool that vanished is the same refusal.
    server.state.tools = [email];
    expect(
      await code(
        s.provider.invoke(
          record.bindings[0]!,
          record.descriptor,
          { city: 'Oslo' },
          ctx,
        ),
      ),
    ).toBe('IncompatibleVersion');
  });

  it('a tool-reported error is ProviderUnavailable and its text never reaches the error', async () => {
    const server = fakeServer();
    const s = await setup(server);
    server.state.error = true;
    const record = s.registry.get({
      id: 'acme.get_weather',
      version: '1.0.0',
    })!;
    const ctx = {
      tenantId: 't-1',
      taskId: 'task',
      executionId: 'x',
      principal: alice,
      signal: new AbortController().signal,
    } as ToolInvocationContext;
    const err = await s.provider
      .invoke(record.bindings[0]!, record.descriptor, { city: 'Oslo' }, ctx)
      .catch((e: Error) => e);
    expect((err as { code: string }).code).toBe('ProviderUnavailable');
    expect(JSON.stringify(err)).not.toContain('secret-detail');
  });
});

describe('Streamable HTTP transport', () => {
  it('sends the session ID after initialize, a Bearer credential, reads JSON and SSE replies, and maps 401 and errors', async () => {
    const sent: {
      headers: Record<string, string>;
      body: { method?: string; id?: number };
    }[] = [];
    const fetch: McpFetch = async (_url, init) => {
      const body = JSON.parse(init.body) as { method?: string; id?: number };
      sent.push({ headers: init.headers, body });
      const json = (result: unknown, extra: Record<string, string> = {}) => ({
        status: 200,
        headers: {
          get: (n: string) =>
            ({ 'content-type': 'application/json', ...extra })[
              n.toLowerCase()
            ] ?? null,
        },
        text: async () =>
          JSON.stringify({ jsonrpc: '2.0', id: body.id, result }),
      });
      if (init.headers['authorization'] === 'Bearer bad')
        return {
          status: 401,
          headers: { get: () => null },
          text: async () => '',
        };
      if (body.method === 'initialize')
        return json({}, { 'mcp-session-id': 'sess-1' });
      if (body.method === 'notifications/initialized')
        return {
          status: 202,
          headers: { get: () => null },
          text: async () => '',
        };
      if (body.method === 'tools/list')
        return {
          status: 200,
          headers: {
            get: (n: string) =>
              n.toLowerCase() === 'content-type' ? 'text/event-stream' : null,
          },
          text: async () =>
            `data: {"jsonrpc":"2.0","method":"notifications/progress"}\n\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools: [weather] } })}\n\n`,
        };
      return {
        status: 200,
        headers: {
          get: (n: string) =>
            n.toLowerCase() === 'content-type' ? 'application/json' : null,
        },
        text: async () =>
          JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            error: { code: -32602, message: 'secret-detail' },
          }),
      };
    };
    const client = new McpClient(
      mcpHttpTransport({ url: 'https://mcp.example/mcp', fetch }),
    );
    const tools = await client.listTools({ credential: { token: 'tok' } });
    expect(tools.map((t) => t.name)).toEqual(['get_weather']);
    const [init, notified, list] = sent;
    expect(init!.headers['mcp-session-id']).toBeUndefined();
    expect(notified!.headers['mcp-session-id']).toBe('sess-1');
    expect(list!.headers).toMatchObject({
      'mcp-session-id': 'sess-1',
      authorization: 'Bearer tok',
    });
    // An error reply carries only its numeric code.
    const err = await client.callTool('x', {}).catch((e: Error) => e);
    expect(
      (err as { code: string; details?: { remoteCode?: number } }).details
        ?.remoteCode,
    ).toBe(-32602);
    expect(JSON.stringify(err)).not.toContain('secret-detail');
    // A rejected credential is AuthorityExpired.
    const fresh = new McpClient(
      mcpHttpTransport({ url: 'https://mcp.example/mcp', fetch }),
    );
    expect(await code(fresh.listTools({ credential: { token: 'bad' } }))).toBe(
      'AuthorityExpired',
    );
  });
});
