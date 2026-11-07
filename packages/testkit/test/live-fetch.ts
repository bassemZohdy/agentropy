// A minimal fetch over node:http(s) for the opt-in live suites. The offline guard keeps the global `fetch` blocked and
// lets TCP through only to endpoints named with `allowNetwork`, so live suites speak HTTP through a plain socket.
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

export interface LiveResponse {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  json(): Promise<unknown>;
}

export function liveFetch(
  url: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  } = {},
): Promise<LiveResponse> {
  return new Promise((resolve, reject) => {
    const send = url.startsWith('https:') ? httpsRequest : httpRequest;
    const req = send(
      url,
      {
        method: init.method ?? 'GET',
        headers: init.headers ?? {},
        ...(init.signal ? { signal: init.signal } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({
            status: res.statusCode ?? 0,
            headers: {
              get: (n) => {
                const v = res.headers[n.toLowerCase()];
                return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
              },
            },
            text: async () => text,
            json: async () => JSON.parse(text) as unknown,
          });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
}
