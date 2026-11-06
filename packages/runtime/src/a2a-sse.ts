/** Server-Sent Events framing for A2A streaming: serialization (server) and parsing (client). */
import { AgentropyError } from '@agentropy/core';
import type { A2AStreamFrame } from './a2a-server.js';

/** Server-Sent Events serialization of stream frames (`text/event-stream`). */
export async function* sseFrames(
  frames: AsyncIterable<A2AStreamFrame>,
): AsyncIterable<string> {
  for await (const f of frames) yield `data: ${JSON.stringify(f)}\n\n`;
}

/** Largest single SSE event accepted from a peer. */
const MAX_SSE_EVENT = 1 << 20;

/** `data:` payloads of a `text/event-stream` body, one per event. */
export async function* sseData(
  body: AsyncIterable<Uint8Array | string>,
): AsyncIterable<string> {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of body) {
    buf +=
      typeof chunk === 'string'
        ? chunk
        : decoder.decode(chunk, { stream: true });
    buf = buf.replace(/\r\n/g, '\n');
    for (let i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) {
      const data = buf
        .slice(0, i)
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).replace(/^ /, ''))
        .join('\n');
      buf = buf.slice(i + 2);
      if (data) yield data;
    }
    if (buf.length > MAX_SSE_EVENT)
      throw new AgentropyError(
        'SchemaViolation',
        'A2A stream event too large',
        {
          details: { protocol: 'a2a', limit: MAX_SSE_EVENT },
        },
      );
  }
}
