/**
 * A2A HTTP binding (FEAT-034.1, A2A 1.0 JSON-RPC over HTTP): a Node `http` request handler serving an `A2AServer`.
 *
 * - `POST <path>` with a JSON-RPC body: unary methods answer `application/json`; `SendStreamingMessage` and
 *   `SubscribeToTask` answer `text/event-stream` (one JSON-RPC response per event, ending after the terminal status).
 * - `GET /.well-known/agent-card.json`: the AgentCard, when one is configured.
 * - The principal comes only from `authenticate(req)` (the application's bearer, mTLS or gateway check); a request
 *   it does not authenticate is answered `401` by the server. Request bodies are bounded; open streams are bounded.
 * - A request target that is not a valid URL (`//`) is answered `400` instead of making the handler reject (FIX-049).
 *
 * The handler returns `false` for paths it does not serve, so a host can route the rest (health probes, metrics).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { TrustedPrincipal } from '@agentropy/core';
import type { A2AHttpResponse, A2AServer } from './a2a-server.js';
import { sseFrames } from './a2a-sse.js';
import { requestPath } from './http-path.js';

/** Well-known AgentCard path (A2A 1.0, section 8.2). */
export const AGENT_CARD_PATH = '/.well-known/agent-card.json';

export interface A2AHttpOptions {
  /**
   * Maps the request's credentials to a trusted principal (verify a bearer token, a client certificate, or headers
   * set by a trusted gateway). Return `undefined` when the request is not authenticated; a throw counts the same.
   */
  authenticate(req: IncomingMessage): Promise<TrustedPrincipal | undefined>;
  /** Served at {@link AGENT_CARD_PATH} (e.g. `agentCardForDefinition(def, url)`). */
  agentCard?: Record<string, unknown>;
  /** Path of the JSON-RPC endpoint (default `/a2a`). */
  path?: string;
  /** Largest request body accepted, in bytes (default 1 MiB); larger requests get `413`. */
  maxBodyBytes?: number;
  /**
   * Streams open at once (default 100); more get `503`. A stream is released as soon as its client goes away.
   */
  maxStreams?: number;
  /**
   * Interval of the `: ping` comment written on an open stream (default 15 s), so a proxy's idle timeout does not cut
   * a stream whose task waits a long time for its next state. Clients ignore SSE comments.
   */
  keepAliveMs?: number;
}

export interface A2AHttpHandler {
  /** Serves the request when its path belongs to the binding; `false` leaves the response untouched. */
  handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
  /** Streams currently open. */
  openStreams(): number;
}

const STREAMING = new Set(['SendStreamingMessage', 'SubscribeToTask']);

class BodyTooLarge extends Error {}

function readBody(req: IncomingMessage, max: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > max) {
      req.resume();
      return reject(new BodyTooLarge());
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) {
        chunks.length = 0;
        req.removeAllListeners('data');
        req.resume();
        reject(new BodyTooLarge());
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function createA2AHttpHandler(
  server: A2AServer,
  o: A2AHttpOptions,
): A2AHttpHandler {
  const endpoint = o.path ?? '/a2a';
  const maxBody = o.maxBodyBytes ?? 1 << 20;
  const maxStreams = o.maxStreams ?? 100;
  let streams = 0;

  const json = (
    res: ServerResponse,
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ) => {
    res.writeHead(status, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      ...headers,
    });
    res.end(JSON.stringify(body));
  };
  const rpcError = (
    res: ServerResponse,
    status: number,
    id: unknown,
    code: number,
    message: string,
    headers: Record<string, string> = {},
  ) =>
    json(
      res,
      status,
      { jsonrpc: '2.0', id: id ?? null, error: { code, message } },
      headers,
    );
  const send = (res: ServerResponse, r: A2AHttpResponse) =>
    json(res, r.status, r.body);

  return {
    openStreams: () => streams,
    async handle(req, res) {
      const path = requestPath(req.url);
      if (path === undefined) {
        req.resume();
        json(res, 400, { error: 'bad request' });
        return true;
      }
      if (path === AGENT_CARD_PATH && o.agentCard) {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          json(res, 405, { error: 'method not allowed' }, { allow: 'GET' });
          return true;
        }
        json(res, 200, o.agentCard, { 'cache-control': 'max-age=300' });
        return true;
      }
      if (path !== endpoint) return false;
      if (req.method !== 'POST') {
        json(res, 405, { error: 'method not allowed' }, { allow: 'POST' });
        return true;
      }
      // Authenticate before reading anything: an unauthenticated caller costs a header check, not a body read.
      const principal = await o.authenticate(req).catch(() => undefined);
      if (!principal) {
        req.resume();
        rpcError(res, 401, null, -32600, 'Authentication required');
        return true;
      }
      const type = String(req.headers['content-type'] ?? '');
      if (!/^application\/(a2a\+)?json\s*(;|$)/i.test(type)) {
        req.resume();
        rpcError(
          res,
          415,
          null,
          -32005,
          'Content type must be application/json',
        );
        return true;
      }
      let raw: string;
      try {
        raw = await readBody(req, maxBody);
      } catch (err) {
        if (err instanceof BodyTooLarge)
          rpcError(res, 413, null, -32600, 'Request body too large', {
            connection: 'close',
          });
        else rpcError(res, 400, null, -32600, 'Request body unreadable');
        return true;
      }
      let request: unknown;
      try {
        request = JSON.parse(raw);
      } catch {
        rpcError(res, 200, null, -32700, 'Parse error');
        return true;
      }
      const version = req.headers['a2a-version'];
      const headers =
        typeof version === 'string' ? { 'a2a-version': version } : {};
      const method = (request as { method?: unknown } | null)?.method;
      const id = (request as { id?: unknown } | null)?.id;
      try {
        if (typeof method !== 'string' || !STREAMING.has(method)) {
          send(res, await server.handle(request, principal, headers));
          return true;
        }
        if (streams >= maxStreams) {
          rpcError(res, 503, id, -32603, 'Too many open streams', {
            'retry-after': '1',
          });
          return true;
        }
        // The client going away ends the stream and releases its task subscription.
        const gone = new AbortController();
        res.on('close', () => gone.abort());
        const r = await server.stream(request, principal, headers, {
          signal: gone.signal,
        });
        if (r.kind === 'error') {
          send(res, r.response);
          return true;
        }
        streams++;
        const ping = setInterval(() => {
          if (!gone.signal.aborted) res.write(': ping\n\n');
        }, o.keepAliveMs ?? 15_000);
        ping.unref();
        try {
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-store',
            connection: 'keep-alive',
          });
          for await (const event of sseFrames(r.frames)) {
            if (gone.signal.aborted) break;
            // A slow reader is waited for (or its disconnect), not buffered without bound.
            if (!res.write(event))
              await new Promise<void>((resolve) => {
                const done = () => {
                  res.off('drain', done);
                  res.off('close', done);
                  resolve();
                };
                res.once('drain', done);
                res.once('close', done);
              });
          }
        } finally {
          clearInterval(ping);
          streams--;
          res.end();
        }
        return true;
      } catch {
        // Never surface internals; the server already maps known errors into JSON-RPC responses.
        if (res.headersSent) res.end();
        else rpcError(res, 500, id, -32603, 'Internal error');
        return true;
      }
    },
  };
}
