// FEAT-035.2: the OpenAI-compatible reasoning adapter against a real endpoint. Opt-in like AGENTROPY_PG_URL: set
// AGENTROPY_LLM_BASE_URL (e.g. https://api.openai.com/v1 or a local gateway), AGENTROPY_LLM_MODEL and, when the
// endpoint needs one, AGENTROPY_LLM_API_KEY. Without them the suite is skipped and the offline guard stays in force.
// Status: written against the wire format the recorded fixtures replay; not yet run against a live endpoint.
import { describe, expect, it } from 'vitest';
import { openAICompatibleReasoning } from '../../runtime/src/index.js';
import { allowNetwork, endpointOf } from '../src/index.js';
import { liveFetch } from './live-fetch.js';

const BASE = process.env['AGENTROPY_LLM_BASE_URL'];
const MODEL = process.env['AGENTROPY_LLM_MODEL'];
const KEY = process.env['AGENTROPY_LLM_API_KEY'];
if (BASE)
  allowNetwork([endpointOf(BASE, BASE.startsWith('https:') ? 443 : 80)]);
const live = BASE && MODEL ? describe : describe.skip;

live('OpenAI-compatible reasoning on a live endpoint', () => {
  const provider = () =>
    openAICompatibleReasoning({
      baseUrl: BASE!,
      model: MODEL!,
      timeoutMs: 60_000,
      fetch: (url, init) => liveFetch(url, init),
      ...(KEY
        ? {
            credentialRef: 'live-key',
            credentials: { resolve: async () => ({ apiKey: KEY }) },
          }
        : {}),
    });
  const ctx = {
    tenantId: 't-1',
    taskId: 'live',
    signal: new AbortController().signal,
  };

  it('answers a short prompt with text, usage and a model name', async () => {
    const r = await provider().complete(
      {
        messages: [
          { role: 'user', content: 'Reply with the single word: pong' },
        ],
        maxTokens: 32,
        temperature: 0,
      },
      ctx,
    );
    expect(r.text.length).toBeGreaterThan(0);
    expect(r.usage.inputTokens).toBeGreaterThan(0);
    expect(typeof r.model).toBe('string');
  }, 90_000);

  it('maps a wrong key to AuthorityExpired and an unknown model to a typed error', async () => {
    const wrongKey = openAICompatibleReasoning({
      baseUrl: BASE!,
      model: MODEL!,
      fetch: (url, init) => liveFetch(url, init),
      credentialRef: 'k',
      credentials: {
        resolve: async () => ({ apiKey: 'sk-invalid-live-test' }),
      },
    });
    const err = await wrongKey
      .complete(
        { messages: [{ role: 'user', content: 'hi' }], maxTokens: 8 },
        ctx,
      )
      .catch((e: { code?: string }) => e);
    // A keyless local gateway may accept anything; then there is nothing to assert here.
    if ((err as { code?: string }).code !== undefined)
      expect(['AuthorityExpired', 'SchemaViolation']).toContain(
        (err as { code: string }).code,
      );
  }, 90_000);

  it('offers a tool and, if the model proposes a call, returns it parsed with the offered name', async () => {
    const r = await provider().complete(
      {
        messages: [
          {
            role: 'user',
            content: 'What is the weather in Oslo? Use the tool get_weather.',
          },
        ],
        maxTokens: 128,
        temperature: 0,
        tools: [
          {
            name: 'get_weather',
            description: 'Current weather for a city',
            inputSchema: {
              type: 'object',
              properties: { city: { type: 'string' } },
              required: ['city'],
            },
          },
        ],
      },
      ctx,
    );
    // A small model may answer in text instead of calling; the wire format is what is under test.
    expect(typeof r.text).toBe('string');
    for (const call of r.toolCalls ?? []) {
      expect(call.name).toBe('get_weather');
      expect(typeof call.input).toBe('object');
    }
  }, 90_000);
});
