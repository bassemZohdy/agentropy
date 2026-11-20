/**
 * MCP client tool provider (FEAT-035.1, R-11): tools of a Model Context Protocol server as Tool v1 tools.
 *
 * - `McpClient` speaks the three methods a tool consumer needs (`initialize`, `tools/list`, `tools/call`) over an
 *   `McpTransport`; `mcpHttpTransport` is the Streamable HTTP transport (JSON or SSE replies, session header).
 * - `mcpToolRegistration` turns a discovered MCP tool into a Tool v1 descriptor and binding. MCP has no idempotency
 *   key, so a tool with effects is `at-least-once` unless the server marks it `idempotentHint`; a read-only tool is
 *   `read`. Discovered tools are candidates: they enter the registry through the normal registration, verification
 *   and activation, never automatically.
 * - `McpToolProvider` is the `ToolProvider`: the executor's PEP, policy, audit, timeout and schema checks all apply
 *   before and after it. The binding pins a digest of the tool's schemas; if the server's current schemas differ the
 *   call fails `IncompatibleVersion` instead of running a changed tool (checked against a cached `tools/list`).
 *
 * Results are data: error text from the server is never copied into errors, only its numeric code.
 */
import { createRequire } from 'node:module';
import {
  AgentropyError,
  digestOf,
  type ToolBinding,
  type ToolDescriptor,
  type ToolInvocationContext,
  type ToolProvider,
} from '@agentropy/core';
import { sseData } from './a2a-sse.js';
import { ReplyTooLarge, readBoundedText, release } from './bounded-body.js';

/** The MCP protocol revision this client asks for. */
export const MCP_PROTOCOL_VERSION = '2025-06-18';

export interface McpCallOptions {
  signal?: AbortSignal;
  /** Resolved per invocation by the executor; the transport decides how to present it (e.g. a Bearer token). */
  credential?: unknown;
}

/** A JSON-RPC transport to one MCP server. */
export interface McpTransport {
  request(
    method: string,
    params: unknown,
    options: McpCallOptions,
  ): Promise<unknown>;
  notify?(
    method: string,
    params: unknown,
    options: McpCallOptions,
  ): Promise<void>;
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: {
    readOnlyHint?: boolean;
    idempotentHint?: boolean;
    destructiveHint?: boolean;
  };
}

export interface McpCallResult {
  content?: { type: string; text?: string }[];
  structuredContent?: unknown;
  isError?: boolean;
}

const unavailable = (what: string, details: Record<string, unknown> = {}) =>
  new AgentropyError('ProviderUnavailable', what, {
    details: { kind: 'tool', protocol: 'mcp', ...details },
  });

/** Version sent as `clientInfo.version`: the runtime package's, read once (`0.0.0` where package.json is not shipped). */
const CLIENT_VERSION = (() => {
  try {
    const pkg = createRequire(import.meta.url)('../package.json') as {
      version?: unknown;
    };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

/** The server no longer knows our session (HTTP 404 for a request that carried its ID): start a new one. */
const sessionLost = (err: unknown): boolean =>
  err instanceof AgentropyError &&
  (err.details as { sessionLost?: unknown } | undefined)?.sessionLost === true;

export class McpClient {
  private ready?: Promise<void>;
  constructor(private readonly transport: McpTransport) {}

  /**
   * Runs `fn` on an initialized session. A server that forgot the session (a restart, a session timeout) answers
   * 404; the client then initializes a new session and repeats the request once, as the MCP specification says. A
   * 404 means the request was not processed, so repeating it cannot run a tool twice. A second loss is an error.
   */
  private async inSession<T>(o: McpCallOptions, fn: () => Promise<T>) {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.init(o);
        return await fn();
      } catch (err) {
        if (attempt > 0 || !sessionLost(err)) throw err;
        this.ready = undefined;
      }
    }
  }

  private init(o: McpCallOptions): Promise<void> {
    this.ready ??= (async () => {
      await this.transport.request(
        'initialize',
        {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'agentropy', version: CLIENT_VERSION },
        },
        o,
      );
      await this.transport.notify?.('notifications/initialized', undefined, o);
    })().catch((err: unknown) => {
      this.ready = undefined; // a failed handshake is retried by the next call
      throw err;
    });
    return this.ready;
  }

  listTools(o: McpCallOptions = {}): Promise<McpTool[]> {
    return this.inSession(o, () => this.listAll(o));
  }

  private async listAll(o: McpCallOptions): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const r = (await this.transport.request(
        'tools/list',
        cursor ? { cursor } : {},
        o,
      )) as { tools?: McpTool[]; nextCursor?: string } | undefined;
      for (const t of r?.tools ?? [])
        if (typeof t?.name === 'string' && t.inputSchema)
          tools.push(t as McpTool);
      cursor = r?.nextCursor;
      if (!cursor) break;
    }
    return tools;
  }

  callTool(
    name: string,
    args: unknown,
    o: McpCallOptions = {},
  ): Promise<McpCallResult> {
    return this.inSession(o, async () => {
      const r = (await this.transport.request(
        'tools/call',
        { name, arguments: args },
        o,
      )) as McpCallResult | undefined;
      if (!r || typeof r !== 'object') throw unavailable('Malformed MCP reply');
      return r;
    });
  }
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');

/** Digest of the parts of a tool the caller's validation depends on. */
export const mcpSchemaDigest = (
  t: Pick<McpTool, 'inputSchema' | 'outputSchema'>,
): string => digestOf({ input: t.inputSchema, output: t.outputSchema ?? null });

/**
 * A discovered MCP tool as a Tool v1 descriptor and its binding. `idPrefix` namespaces the server's tool names
 * (e.g. `files` → `files.read-file`); `version` is the registered tool version (the MCP server has none per tool).
 */
export function mcpToolRegistration(
  tool: McpTool,
  o: { idPrefix: string; version: string; providerVersion?: string },
): { descriptor: ToolDescriptor; binding: ToolBinding } {
  const id = `${slug(o.idPrefix)}.${slug(tool.name)}`;
  const read = tool.annotations?.readOnlyHint === true;
  const descriptor: ToolDescriptor = {
    id,
    version: o.version,
    description: (tool.description ?? tool.name).slice(0, 2000) || tool.name,
    inputSchema: tool.inputSchema,
    ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
    effect: read ? 'read' : 'external',
    // MCP carries no idempotency key: only a server's own idempotent hint lifts the at-least-once default.
    idempotency: read
      ? 'idempotent'
      : tool.annotations?.idempotentHint === true
        ? 'idempotent'
        : 'at-least-once',
    permission: `tool:${id}:call`,
  };
  const binding: ToolBinding = {
    bindingId: 'mcp',
    toolId: id,
    toolVersion: o.version,
    providerId: 'mcp',
    providerVersion: o.providerVersion ?? '1.0.0',
    config: { tool: tool.name, schemaDigest: mcpSchemaDigest(tool) },
    default: true,
  };
  return { descriptor, binding };
}

export class McpToolProvider implements ToolProvider {
  readonly id = 'mcp';
  readonly version = '1.0.0';
  readonly features = {
    protocol: 'mcp',
    protocolVersion: MCP_PROTOCOL_VERSION,
    cancellation: true,
    idempotencyKeys: false,
    streaming: false,
  };
  private listed?: { at: number; digests: Map<string, string> };

  constructor(
    private readonly client: McpClient,
    private readonly o: {
      /** How long a `tools/list` answer is trusted for the schema check (default 5 min). */
      schemaTtlMs?: number;
      now?: () => number;
    } = {},
  ) {}

  private async current(
    name: string,
    opts: McpCallOptions,
  ): Promise<string | undefined> {
    const now = (this.o.now ?? Date.now)();
    if (
      !this.listed ||
      now - this.listed.at > (this.o.schemaTtlMs ?? 300_000)
    ) {
      const tools = await this.client.listTools(opts);
      this.listed = {
        at: now,
        digests: new Map(tools.map((t) => [t.name, mcpSchemaDigest(t)])),
      };
    }
    return this.listed.digests.get(name);
  }

  async invoke(
    binding: ToolBinding,
    d: ToolDescriptor,
    input: unknown,
    ctx: ToolInvocationContext,
  ): Promise<unknown> {
    const name = String(binding.config['tool'] ?? d.id);
    const opts: McpCallOptions = {
      signal: ctx.signal,
      ...(ctx.credential !== undefined ? { credential: ctx.credential } : {}),
    };
    const pinned = binding.config['schemaDigest'];
    if (typeof pinned === 'string') {
      const now = await this.current(name, opts);
      if (now !== pinned) {
        // The listing may be stale: look once more before refusing.
        this.listed = undefined;
        if ((await this.current(name, opts)) !== pinned)
          throw new AgentropyError(
            'IncompatibleVersion',
            `The MCP server's schema for ${d.id} changed since it was registered`,
            { details: { kind: 'tool', protocol: 'mcp' } },
          );
      }
    }
    const res = await this.client.callTool(name, input, opts);
    if (res.isError === true)
      throw unavailable('The MCP tool reported an error');
    if (res.structuredContent !== undefined) return res.structuredContent;
    return {
      text: (res.content ?? [])
        .filter((c) => c.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text)
        .join('\n'),
    };
  }
}

/** The part of a fetch `Response` the HTTP transport reads. */
export interface McpHttpResponse {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  /** The body stream, when the fetch has one: cancelled when the reply is not read (FIX-085). */
  body?: unknown;
}

export type McpFetch = (
  url: string,
  init: {
    method: 'POST';
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
    redirect: 'manual';
  },
) => Promise<McpHttpResponse>;

/**
 * Streamable HTTP transport (MCP 2025-06-18): every message is a POST to one endpoint; a reply is JSON or an SSE
 * stream that carries the response; the session ID the server issues at `initialize` is sent on later requests.
 * A credential `{ token }` becomes a Bearer header. Redirects are never followed and replies are size-bounded.
 */
export function mcpHttpTransport(o: {
  url: string;
  fetch: McpFetch;
  /** Extra static headers (not credentials). */
  headers?: Record<string, string>;
  maxResponseBytes?: number;
}): McpTransport {
  let seq = 0;
  let session: string | undefined;
  const send = async (
    message: Record<string, unknown>,
    opts: McpCallOptions,
  ): Promise<McpHttpResponse> => {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': MCP_PROTOCOL_VERSION,
      ...o.headers,
    };
    const sent = session;
    if (sent) headers['mcp-session-id'] = sent;
    const token = (opts.credential as { token?: unknown } | undefined)?.token;
    if (typeof token === 'string') headers['authorization'] = `Bearer ${token}`;
    let res: McpHttpResponse;
    try {
      res = await o.fetch(o.url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', ...message }),
        ...(opts.signal ? { signal: opts.signal } : {}),
        redirect: 'manual',
      });
    } catch (err) {
      if (err instanceof AgentropyError) throw err;
      throw unavailable('The MCP server is unreachable');
    }
    // An error reply is not read: release its body so the connection is not held until garbage collection (FIX-085).
    if (res.status >= 300) release(res.body);
    if (res.status === 401 || res.status === 403)
      throw new AgentropyError(
        'AuthorityExpired',
        'The MCP server rejected our credential',
        { details: { kind: 'credential', status: 'expired' } },
      );
    // The server does not know this session (it restarted or dropped it): forget it, so the client can start a new
    // one (MCP 2025-06-18, session management).
    if (res.status === 404 && sent) {
      if (session === sent) session = undefined;
      throw unavailable('The MCP session ended', {
        status: 404,
        sessionLost: true,
      });
    }
    if (res.status >= 300)
      throw unavailable('The MCP server refused the request', {
        status: res.status,
      });
    return res;
  };
  return {
    async request(method, params, opts) {
      const id = ++seq;
      const res = await send({ id, method, params }, opts);
      const sid = res.headers.get('mcp-session-id');
      if (method === 'initialize' && sid) session = sid;
      let text: string;
      try {
        text = await readBoundedText(
          res,
          o.maxResponseBytes ?? 1 << 20,
          opts.signal,
        );
      } catch (err) {
        throw unavailable(
          err instanceof ReplyTooLarge
            ? 'The MCP reply is too large'
            : 'The MCP reply could not be read',
        );
      }
      const messages: unknown[] = [];
      if (
        (res.headers.get('content-type') ?? '').includes('text/event-stream')
      ) {
        for await (const data of sseData(
          (async function* () {
            yield text;
          })(),
        )) {
          try {
            messages.push(JSON.parse(data));
          } catch {
            /* a malformed event is skipped */
          }
        }
      } else {
        try {
          messages.push(JSON.parse(text));
        } catch {
          throw unavailable('Malformed MCP reply');
        }
      }
      const reply = (
        messages.flat() as {
          id?: unknown;
          result?: unknown;
          error?: { code?: number };
        }[]
      ).find((m) => m?.id === id);
      if (!reply) throw unavailable('No MCP reply for the request');
      if (reply.error)
        throw unavailable('The MCP server returned an error', {
          remoteCode: reply.error.code ?? null,
        });
      return reply.result;
    },
    async notify(method, params, opts) {
      const res = await send({ method, params }, opts);
      // A notification has no reply (202, no body): whatever the server sends anyway is not read (FIX-085).
      release(res.body);
    },
  };
}
