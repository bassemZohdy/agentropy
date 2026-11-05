// AC-18: the reusable communication conformance suite passes against the direct provider; undeclared
// operations fail UnsupportedOperation.
import {
  isAgentropyError,
  type AgentCommunicationProvider,
  type TrustedPrincipal,
} from '@agentropy/core';
import {
  FakeDirectTarget,
  defineCommunicationConformance,
} from '@agentropy/testkit';
import { describe, expect, it } from 'vitest';
import {
  DefaultCommunicationRouter,
  DirectCommunicationProvider,
} from '../src/communication.js';

const caller: TrustedPrincipal = {
  id: 'inst-1',
  type: 'agent',
  tenantId: 't-1',
};
const target = {
  definitionId: 'price-watch',
  version: '1.0.0',
  tenantId: 't-1',
};

defineCommunicationConformance({ describe, it, expect }, 'direct', () => {
  const fake = new FakeDirectTarget();
  const provider = new DirectCommunicationProvider(
    fake,
    'durable-acceptance',
    't-1',
    () => '2026-11-05T00:00:00.000Z',
  );
  const router = new DefaultCommunicationRouter();
  router.register(provider);
  return { router, provider, target, caller, received: () => fake.received };
});

async function code(p: Promise<unknown>) {
  try {
    await p;
    return 'no-error';
  } catch (err) {
    return isAgentropyError(err) ? err.code : 'non-agentropy';
  }
}

describe('router selection rules (Communication v1)', () => {
  const limited = (
    id: string,
    ops: AgentCommunicationProvider['features']['operations'],
    over: Partial<AgentCommunicationProvider> = {},
  ): AgentCommunicationProvider =>
    ({
      id,
      features: {
        operations: ops,
        streaming: false,
        pushNotifications: false,
        durability: 'provider-dependent',
        protocol: id,
        protocolVersion: '1',
      },
      supports: () => true,
      ...over,
    }) as AgentCommunicationProvider;

  it('an operation no provider declares fails UnsupportedOperation (AC-18)', async () => {
    const router = new DefaultCommunicationRouter();
    router.register(limited('broker', ['send']));
    expect(
      await code(
        router.selectRoute(target, 'delegate', { caller, correlationId: 'c' }),
      ),
    ).toBe('UnsupportedOperation');
  });

  it('no reachable provider fails NoCompatibleRoute; provider-dependent durability satisfies only none', async () => {
    const router = new DefaultCommunicationRouter();
    expect(
      await code(
        router.selectRoute(target, 'delegate', { caller, correlationId: 'c' }),
      ),
    ).toBe('NoCompatibleRoute');
    router.register(limited('broker', ['delegate']));
    expect(
      await code(
        router.selectRoute(
          target,
          'delegate',
          { caller, correlationId: 'c' },
          { durability: 'durable-acceptance' },
        ),
      ),
    ).toBe('GuaranteeUnavailable');
    expect(
      (
        await router.selectRoute(
          target,
          'delegate',
          { caller, correlationId: 'c' },
          { durability: 'none' },
        )
      ).providerId,
    ).toBe('broker');
  });

  it('prefers direct for co-located targets and a remote provider for addressable ones', async () => {
    const router = new DefaultCommunicationRouter();
    router.register(
      new DirectCommunicationProvider(
        new FakeDirectTarget(),
        'durable-acceptance',
      ),
    );
    router.register(limited('a2a', ['delegate']));
    expect(
      (
        await router.selectRoute(target, 'delegate', {
          caller,
          correlationId: 'c',
        })
      ).providerId,
    ).toBe('direct');
    expect(
      (
        await router.selectRoute(
          { ...target, endpoint: 'https://agents.example/price-watch' },
          'delegate',
          { caller, correlationId: 'c' },
        )
      ).providerId,
    ).toBe('a2a');
  });

  it('an optional PDP is consulted before route selection and fails closed', async () => {
    const router = new DefaultCommunicationRouter({
      decide: async () => Promise.reject(new Error('down')),
    });
    router.register(
      new DirectCommunicationProvider(
        new FakeDirectTarget(),
        'durable-acceptance',
      ),
    );
    expect(
      await code(
        router.selectRoute(target, 'delegate', { caller, correlationId: 'c' }),
      ),
    ).toBe('PolicyDecisionUnavailable');
  });

  it('duplicate provider IDs are rejected', () => {
    const router = new DefaultCommunicationRouter();
    router.register(limited('x', ['send']));
    expect(() => router.register(limited('x', ['send']))).toThrowError(
      /already registered/,
    );
  });
});
