// FEAT-028.9: registry federation and discovery through A2A agent cards (M3-09, R-18) — publish a local
// definition as a card, import cards only from configured peers, validate them as untrusted data, scope them by
// tenant and policy, and delegate to a discovered agent end to end.
import {
  BUILTIN_PROFILES,
  type AgentDefinition,
  type TrustedPrincipal,
} from '@agentropy/core';
import { describe, expect, it } from 'vitest';
import {
  A2ACommunicationProvider,
  AgentDirectoryFederation,
  DefaultCommunicationRouter,
  agentCardForDefinition,
  createA2AServer,
  createLocalApp,
  localAppTarget,
  type FederationFetch,
} from '../../runtime/src/index.js';
import { code, sqliteTempStore } from '../../runtime/test/harness.js';
import { FakeClock, FakePolicy } from '../src/index.js';

const alice: TrustedPrincipal = { id: 'alice', type: 'user', tenantId: 't-1' };
const eve: TrustedPrincipal = { id: 'eve', type: 'user', tenantId: 't-2' };
const CARD_URL = 'https://b.example/.well-known/agent-card.json';
const ENDPOINT = 'https://b.example/a2a';

const summarizer: AgentDefinition = {
  id: 'summarizer',
  version: '1.2.0',
  displayName: 'Summarizer',
  description: 'Summarizes long documents',
  profile: { id: 'task', version: '1.0.0' },
  implementation: {
    providerId: 'native-ts',
    providerVersion: '1.0.0',
    artifact: { id: 'summarizer', version: '1.2.0' },
  },
  inputSchema: true,
  runtimeRequirements: { guarantees: [] },
  policyRef: { id: 'default', version: '1.0.0' },
  capabilities: [{ id: 'reasoning', versionRange: '^1.0.0' }],
};

/** Peers served by URL; requests to anything else fail like an unknown host. */
function web(cards: Record<string, unknown>) {
  const requested: string[] = [];
  const fetch: FederationFetch = async (url) => {
    requested.push(url);
    if (!(url in cards)) throw new TypeError('fetch failed');
    const body = cards[url];
    return {
      status: body === 404 ? 404 : 200,
      text: async () =>
        typeof body === 'string' ? body : JSON.stringify(body),
    };
  };
  return { fetch, requested };
}

function federation(
  cards: Record<string, unknown>,
  extra: Partial<
    ConstructorParameters<typeof AgentDirectoryFederation>[0]
  > = {},
) {
  const clock = new FakeClock('2026-11-06T00:00:00.000Z');
  const pdp = new FakePolicy();
  const w = web(cards);
  const fed = new AgentDirectoryFederation({
    peers: [{ id: 'finance-eu', cardUrl: CARD_URL, tenants: ['t-1'] }],
    fetch: w.fetch,
    pdp,
    now: clock.iso,
    ...extra,
  });
  return { fed, clock, pdp, ...w };
}

describe('publishing and importing agent cards (M3-09)', () => {
  it('a published definition is discovered by a peer with a ready delegation target', async () => {
    const card = agentCardForDefinition(summarizer, ENDPOINT);
    const { fed } = federation({ [CARD_URL]: card });
    expect(await fed.refresh()).toEqual([{ peerId: 'finance-eu', ok: true }]);
    const [entry] = await fed.discover({ capability: 'reasoning' }, alice);
    expect(entry).toMatchObject({
      peerId: 'finance-eu',
      definitionId: 'summarizer',
      version: '1.2.0',
      endpoint: ENDPOINT,
      protocolVersion: '1.0',
      stale: false,
      target: {
        remote: {
          endpoint: ENDPOINT,
          definitionId: 'summarizer',
          version: '1.2.0',
        },
      },
    });
    expect(await fed.discover({ text: 'summarizes' }, alice)).toHaveLength(1);
    expect(await fed.discover({ profile: 'monitoring' }, alice)).toEqual([]);
    expect(await fed.discover({ id: 'other' }, alice)).toEqual([]);
  });

  it('peers are visible only to their tenants and only where policy allows; a policy outage fails closed', async () => {
    const { fed, pdp } = federation({
      [CARD_URL]: agentCardForDefinition(summarizer, ENDPOINT),
    });
    await fed.refresh();
    expect(await fed.discover({}, eve)).toEqual([]);
    pdp.denied.add('definition:discover@finance-eu/summarizer');
    expect(await fed.discover({}, alice)).toEqual([]);
    pdp.denied.clear();
    pdp.down = true;
    expect(await code(fed.discover({}, alice))).toBe(
      'PolicyDecisionUnavailable',
    );
  });

  it('rejects cards that point elsewhere, use the wrong protocol, are oversized or malformed', async () => {
    const good = agentCardForDefinition(summarizer, ENDPOINT) as {
      supportedInterfaces: { url: string; protocolVersion: string }[];
    };
    const variants: [string, unknown][] = [
      [
        'foreign endpoint',
        {
          ...good,
          supportedInterfaces: [
            { ...good.supportedInterfaces[0], url: 'https://evil.example/a2a' },
          ],
        },
      ],
      [
        'plain http',
        {
          ...good,
          supportedInterfaces: [
            { ...good.supportedInterfaces[0], url: 'http://b.example/a2a' },
          ],
        },
      ],
      [
        'old protocol',
        {
          ...good,
          supportedInterfaces: [
            { ...good.supportedInterfaces[0], protocolVersion: '0.3' },
          ],
        },
      ],
      ['huge', JSON.stringify({ ...good, description: 'x'.repeat(70_000) })],
      ['not json', '<html>'],
      ['missing name', { ...good, name: undefined }],
    ];
    for (const [why, card] of variants) {
      const { fed } = federation({ [CARD_URL]: card });
      const [r] = await fed.refresh();
      expect([why, r!.ok, r!.error]).toEqual([why, false, 'SchemaViolation']);
      expect(await fed.discover({}, alice)).toEqual([]);
    }
    // An explicitly allowed origin may host the endpoint.
    const elsewhere = agentCardForDefinition(
      summarizer,
      'https://gw.example/a2a',
    );
    const { fed } = federation(
      { [CARD_URL]: elsewhere },
      {
        peers: [
          {
            id: 'finance-eu',
            cardUrl: CARD_URL,
            tenants: ['t-1'],
            allowedOrigins: ['https://gw.example'],
          },
        ],
      },
    );
    expect((await fed.refresh())[0]!.ok).toBe(true);
  });

  it('only configured https peers are ever fetched; a failing peer keeps its last good card until it is too old', async () => {
    const cards: Record<string, unknown> = {
      [CARD_URL]: agentCardForDefinition(summarizer, ENDPOINT),
    };
    const { fed, clock, requested } = federation(cards, {
      refreshMs: 60_000,
      maxStaleMs: 3_600_000,
    });
    expect(
      () =>
        new AgentDirectoryFederation({
          peers: [
            { id: 'x', cardUrl: 'http://x.example/card', tenants: ['t-1'] },
          ],
          fetch: async () => ({ status: 200, text: async () => '' }),
          pdp: new FakePolicy(),
        }),
    ).toThrow(/https/);
    await fed.refresh();
    await fed.refresh(); // within refreshMs: no request
    expect(requested).toEqual([CARD_URL]);

    delete cards[CARD_URL];
    clock.advanceBy(120_000);
    expect((await fed.refresh())[0]).toMatchObject({
      ok: false,
      error: 'RemoteUnavailable',
    });
    const [still] = await fed.discover({}, alice);
    expect(still?.stale).toBe(true);
    clock.advanceBy(3_600_000);
    expect(await fed.discover({}, alice)).toEqual([]);
  });
});

describe('discover, then delegate (M3-09 end to end)', () => {
  it('runtime A finds runtime B’s agent through its card and delegates to it over A2A', async () => {
    // Runtime B publishes its summarizer at an A2A endpoint.
    const b = createLocalApp({
      store: sqliteTempStore(),
      pdp: new FakePolicy(),
      now: new FakeClock('2026-11-06T00:00:00.000Z').iso,
      profiles: BUILTIN_PROFILES,
    });
    b.define(summarizer, {
      handle: async (inv) => ({
        kind: 'completed',
        output: { summary: `summary of ${(inv.input as { doc: string }).doc}` },
      }),
    });
    const bob: TrustedPrincipal = { id: 'bob', type: 'user', tenantId: 't-1' };
    const inst = await b.createInstance(
      {
        definition: { id: 'summarizer', version: '1.2.0' },
        ownerId: 'bob',
        idempotencyKey: 's',
      },
      bob,
    );
    const server = createA2AServer(localAppTarget(b), { instanceId: inst.id });

    // Runtime A: federation over B's card, A2A provider authenticated as service runtime-a.
    const { fed } = federation({
      [CARD_URL]: agentCardForDefinition(summarizer, ENDPOINT),
    });
    await fed.refresh();
    const router = new DefaultCommunicationRouter();
    router.register(
      new A2ACommunicationProvider({
        credentialRef: 'peer-b',
        credentials: { resolve: async () => ({ token: 'tok-a' }) },
        maxPolls: 0,
        fetch: async (_url, init) => {
          const res = await server.handle(
            JSON.parse(init.body),
            init.headers.authorization === 'Bearer tok-a'
              ? { id: 'runtime-a', type: 'service', tenantId: 't-1' }
              : undefined,
            { 'a2a-version': init.headers['a2a-version'] },
          );
          return { status: res.status, json: async () => res.body };
        },
      }),
    );
    const a = createLocalApp({
      store: sqliteTempStore(),
      pdp: new FakePolicy(),
      now: new FakeClock('2026-11-06T00:00:00.000Z').iso,
      profiles: BUILTIN_PROFILES,
      communication: { router },
    });

    const [found] = await fed.discover({ text: 'summar' }, alice);
    const handle = await a.delegate(
      {
        target: found!.target,
        input: { doc: 'annual-report' },
        idempotencyKey: 'fed-1',
        correlationId: 'fed-1',
      },
      alice,
    );
    await b.runUntilIdle();
    await a.runUntilIdle();
    expect(await a.getResult(handle.taskId, alice)).toEqual({
      summary: 'summary of annual-report',
    });
  });
});
