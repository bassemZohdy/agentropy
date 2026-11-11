/**
 * Receiving A2A push notifications for remote projections (FEAT-048; docs/plans/FEAT-048-outbound-push.md).
 *
 * A notification is a **wake-up signal, not data**. The receiver authenticates it with a per-task HMAC token, then asks
 * the host to refresh that one projection (`LocalApp.refreshRemote`), which calls `GetTask` at the peer through the
 * normal, validated path. The payload is never parsed, so a forged, replayed or hostile notification can cost one
 * rate-limited `GetTask` and nothing more, and a lost one only means the slower polling runs.
 *
 * - **Token.** `a2aPushToken(secret, localTaskId)`: derived, never stored. The provider sends it to the peer when it
 *   registers the webhook; the peer returns it in `X-A2A-Notification-Token`. A token for one task is useless for
 *   another, and rotating the secret invalidates old tokens.
 * - **Authenticate first.** The token is compared in constant time before the body is touched: a wrong or missing one
 *   is `401` and the body is drained unread. A valid notification's body is bounded (`413`) and discarded.
 * - **Coalescing.** At most one refresh per task per `minIntervalMs` (default 1 s): the first runs at once and a burst
 *   is answered `202` and folded into one trailing refresh, so the last state is never lost.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { AgentropyError } from '@agentropy/core';

/** Header the peer sends the token in (A2A 1.0 push notifications). */
const TOKEN_HEADER = 'x-a2a-notification-token';
const DEFAULT_PATH = '/a2a/push';

/** The token a peer must present for one remote projection (`localTaskId`, e.g. `a2a:<remote id>`). */
export function a2aPushToken(secret: string, localTaskId: string): string {
  return createHmac('sha256', secret)
    .update(`agentropy/a2a-push/v1:${localTaskId}`)
    .digest('base64url');
}

export interface A2APushReceiverOptions {
  /** The shared secret the provider's `push.secret` uses; at least 32 bytes. */
  secret: string;
  /** Refreshes one projection now, e.g. `(id) => app.refreshRemote(id)`. Failures are contained. */
  refresh: (localTaskId: string) => Promise<unknown>;
  /** Path prefix of the receiver (default `/a2a/push`); the task ID follows it, URL-encoded. */
  path?: string;
  /** Largest body accepted from a peer, in bytes (default 64 KiB); the body is read only to be discarded. */
  maxBodyBytes?: number;
  /** Minimum time between refreshes of one task (default 1,000 ms; 0 refreshes on every notification). */
  minIntervalMs?: number;
}

export interface A2APushReceiver {
  /** The answer to a notification for a task: `202` accepted (refresh scheduled or coalesced) or `401`. */
  notify(localTaskId: string, token: string | undefined): Promise<202 | 401>;
  /** Serves `POST <path>/<task id>`; `false` leaves the response untouched when the path is not the receiver's. */
  handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
  /** Resolves once the refreshes started so far, and any trailing ones, have finished. */
  idle(): Promise<void>;
}

/** Entries kept for coalescing; a flood of distinct task IDs cannot grow it without limit. */
const MAX_TRACKED = 10_000;

export function createA2APushReceiver(
  o: A2APushReceiverOptions,
): A2APushReceiver {
  if (Buffer.byteLength(o.secret, 'utf8') < 32)
    throw new AgentropyError(
      'InvalidConfiguration',
      'The push receiver secret must be at least 32 bytes',
    );
  const base = (o.path ?? DEFAULT_PATH).replace(/\/+$/, '');
  const maxBody = o.maxBodyBytes ?? 64 * 1024;
  const minInterval = o.minIntervalMs ?? 1_000;
  const state = new Map<
    string,
    { last: number; trailing?: ReturnType<typeof setTimeout> }
  >();
  const inflight = new Set<Promise<void>>();

  const run = (id: string) => {
    const p: Promise<void> = Promise.resolve()
      .then(() => o.refresh(id))
      .then(
        () => undefined,
        () => undefined, // the host logs its own failures; a notification never fails because of one
      )
      .finally(() => inflight.delete(p));
    inflight.add(p);
  };

  const authentic = (id: string, token: string | undefined): boolean => {
    if (typeof token !== 'string') return false;
    const want = Buffer.from(a2aPushToken(o.secret, id));
    const got = Buffer.from(token);
    return got.length === want.length && timingSafeEqual(got, want);
  };

  const notify: A2APushReceiver['notify'] = async (id, token) => {
    if (!authentic(id, token)) return 401;
    const now = Date.now();
    let s = state.get(id);
    if (!s) {
      if (state.size >= MAX_TRACKED)
        for (const [k, v] of state) if (!v.trailing) state.delete(k);
      s = { last: Number.NEGATIVE_INFINITY };
      state.set(id, s);
    }
    const elapsed = now - s.last;
    if (elapsed >= minInterval) {
      s.last = now;
      run(id);
    } else if (!s.trailing) {
      const entry = s;
      entry.trailing = setTimeout(() => {
        entry.trailing = undefined;
        entry.last = Date.now();
        run(id);
      }, minInterval - elapsed);
      entry.trailing.unref();
    }
    return 202;
  };

  const reply = (
    res: ServerResponse,
    status: number,
    headers: Record<string, string> = {},
  ) => {
    res.writeHead(status, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      ...headers,
    });
    res.end('{}');
  };

  /** Reads and throws away a body up to the bound; false when it is larger. */
  const discard = (req: IncomingMessage): Promise<boolean> =>
    new Promise((resolve) => {
      let size = 0;
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > maxBody) {
          req.removeAllListeners('data');
          req.resume();
          resolve(false);
        }
      });
      req.on('end', () => resolve(true));
      req.on('error', () => resolve(false));
    });

  return {
    notify,
    async handle(req, res) {
      const path = new URL(req.url ?? '/', 'http://receiver.invalid').pathname;
      if (!path.startsWith(`${base}/`)) return false;
      let id: string;
      try {
        id = decodeURIComponent(path.slice(base.length + 1));
      } catch {
        return false;
      }
      if (!id) return false;
      if (req.method !== 'POST') {
        req.resume();
        reply(res, 405, { allow: 'POST' });
        return true;
      }
      const header = req.headers[TOKEN_HEADER];
      const token = Array.isArray(header) ? header[0] : header;
      // Authenticate before reading anything: a forged notification costs a header check, not a body read.
      if (!authentic(id, token)) {
        req.resume();
        reply(res, 401, { connection: 'close' });
        return true;
      }
      const declared = Number(req.headers['content-length']);
      if (Number.isFinite(declared) && declared > maxBody) {
        req.resume();
        reply(res, 413, { connection: 'close' });
        return true;
      }
      if (!(await discard(req))) {
        reply(res, 413, { connection: 'close' });
        return true;
      }
      reply(res, await notify(id, token));
      return true;
    },
    async idle() {
      for (;;) {
        while (inflight.size) await Promise.all([...inflight]);
        if (![...state.values()].some((s) => s.trailing)) return;
        await new Promise((r) => setTimeout(r, 5));
      }
    },
  };
}
