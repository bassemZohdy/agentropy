/**
 * Reads a peer's reply body with a cap and a deadline (TASK-068). A reply from a peer (an MCP server, an A2A peer, a
 * federation card, a model endpoint) is untrusted input: it is refused as soon as it passes the cap, without being
 * buffered whole, and a body that stalls ends with the caller's abort signal instead of waiting for ever.
 */

/** The part of a fetch `Response` a reader uses. Test doubles may offer only `text()` or `json()`. */
export interface ReplyBody {
  body?: unknown;
  headers?: { get(name: string): string | null };
  text?(): Promise<string>;
  json?(): Promise<unknown>;
}

/** The reply passed the cap. */
export class ReplyTooLarge extends Error {
  constructor(readonly maxBytes: number) {
    super(`Reply exceeds ${maxBytes} bytes`);
    this.name = 'ReplyTooLarge';
  }
}

/** The reply arrived but is not JSON. */
export class ReplyNotJson extends Error {
  constructor() {
    super('Reply is not JSON');
    this.name = 'ReplyNotJson';
  }
}

interface WebReader {
  read(): Promise<{ done: boolean; value?: Uint8Array | string }>;
  cancel(reason?: unknown): Promise<unknown>;
}

const sizeOf = (chunk: Uint8Array | string): number =>
  typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength;

/** Rejects when `signal` aborts; resolves with `p` otherwise. */
function until<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return p;
  if (signal.aborted)
    return Promise.reject(signal.reason ?? new Error('aborted'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/** Cancels a reply body that will not be read, so its connection is released now rather than at garbage collection. */
export const release = (body: unknown): void => {
  const b = body as { cancel?: () => Promise<unknown> } | null | undefined;
  void Promise.resolve(b?.cancel?.()).catch(() => undefined);
};

/**
 * The body as text, at most `maxBytes` long. A declared `content-length` over the cap is refused before a byte is
 * read; a streamed body is cut off, and its connection released, at the first chunk that passes the cap.
 */
export async function readBoundedText(
  res: ReplyBody,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<string> {
  const declared = Number(res.headers?.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    release(res.body);
    throw new ReplyTooLarge(maxBytes);
  }
  const body = res.body as
    | { getReader?: () => WebReader }
    | AsyncIterable<Uint8Array | string>
    | null
    | undefined;
  const chunks: (Uint8Array | string)[] = [];
  let total = 0;
  const take = (chunk: Uint8Array | string): void => {
    total += sizeOf(chunk);
    if (total > maxBytes) throw new ReplyTooLarge(maxBytes);
    chunks.push(chunk);
  };
  if (
    body &&
    typeof (body as { getReader?: unknown }).getReader === 'function'
  ) {
    const reader = (body as { getReader: () => WebReader }).getReader();
    try {
      for (;;) {
        const next = await until(reader.read(), signal);
        if (next.done) break;
        take(next.value!);
      }
    } catch (err) {
      void reader.cancel().catch(() => undefined);
      throw err;
    }
  } else if (body && Symbol.asyncIterator in (body as object)) {
    const it = (body as AsyncIterable<Uint8Array | string>)[
      Symbol.asyncIterator
    ]();
    try {
      for (;;) {
        const next = await until(it.next(), signal);
        if (next.done) break;
        take(next.value);
      }
    } catch (err) {
      void Promise.resolve(it.return?.()).catch(() => undefined);
      throw err;
    }
  } else if (typeof res.text === 'function') {
    const text = await until(res.text(), signal);
    if (Buffer.byteLength(text) > maxBytes) throw new ReplyTooLarge(maxBytes);
    return text;
  } else if (typeof res.json === 'function') {
    const text = JSON.stringify(await until(res.json(), signal));
    if (Buffer.byteLength(text) > maxBytes) throw new ReplyTooLarge(maxBytes);
    return text;
  } else return '';
  const decoder = new TextDecoder();
  return (
    chunks
      .map((c) =>
        typeof c === 'string' ? c : decoder.decode(c, { stream: true }),
      )
      .join('') + decoder.decode()
  );
}

/** The body parsed as JSON under the same cap; a body that is not JSON is `ReplyNotJson`. */
export async function readBoundedJson(
  res: ReplyBody,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<unknown> {
  const text = await readBoundedText(res, maxBytes, signal);
  try {
    return JSON.parse(text);
  } catch {
    throw new ReplyNotJson();
  }
}
