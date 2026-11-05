// CT-IMPLEMENTATION: Agent Implementation v1 provider-level conformance.
// "Two providers pass the same lifecycle tests" (A-02) needs the TaskService and is verified in FEAT-017.
import {
  BUILTIN_PROFILES,
  CAPABILITY_CATALOG,
  isAgentropyError,
  resolveAcceptance,
  type AcceptanceEnvironment,
  type AgentContext,
  type AgentDefinition,
} from '@agentropy/core';
import { describe, expect, it } from 'vitest';
import {
  InMemoryHandlerRegistry,
  InMemoryImplementationProviderRegistry,
  NativeImplementationProvider,
} from '../src/implementation.js';

const artifact = { id: 'expense-approval', version: '1.0.0' };
const handler = {
  handle: async () => ({ kind: 'completed' as const, output: { ok: true } }),
};
const ctx = {} as AgentContext;
const invocation = {
  taskId: 't',
  executionId: 'e',
  activation: 1,
  attempt: 1,
  input: {},
  trigger: 'delegation' as const,
};

const definition: AgentDefinition = {
  id: 'expense-approval',
  version: '1.0.0',
  displayName: 'Expense approval',
  profile: { id: 'task', version: '1.0.0' },
  implementation: {
    providerId: 'native-ts',
    providerVersion: '1.0.0',
    artifact,
  },
  inputSchema: true,
  runtimeRequirements: { guarantees: [] },
  policyRef: { id: 'default', version: '1.0.0' },
};

function env(
  registry: InMemoryImplementationProviderRegistry,
): AcceptanceEnvironment {
  return {
    contracts: CAPABILITY_CATALOG,
    profiles: BUILTIN_PROFILES,
    providers: [
      {
        id: 'builtin',
        version: '1.0.0',
        contracts: CAPABILITY_CATALOG.map((c) => ({
          id: c.id,
          version: c.version,
          level: c.id === 'durability' ? 'durable-execution' : undefined,
        })),
      },
    ],
    runtimeDurability: 'durable-execution',
    implementationProvider: (id, v) => registry.find(id, v),
    toolVersions: () => [],
    toolProviderRegistered: () => false,
    skillVersions: () => [],
    pdp: { decide: async () => ({ effect: 'allow' }) },
    now: () => '2026-11-05T00:00:00.000Z',
  };
}

describe('native-ts implementation provider (CT-IMPLEMENTATION)', () => {
  it('resolves a registered artifact into a pinned binding with declared features', async () => {
    const handlers = new InMemoryHandlerRegistry();
    handlers.register(artifact, handler);
    const binding = await new NativeImplementationProvider(handlers).resolve(
      definition.implementation,
    );
    expect(binding).toEqual({
      providerId: 'native-ts',
      providerVersion: '1.0.0',
      artifact,
      features: {
        checkpointResume: true,
        cooperativeCancellation: true,
        progressReporting: true,
        isolation: 'in-process',
        remoteAuthority: false,
      },
    });
  });

  it('an unknown artifact is NotFound', async () => {
    await expect(
      new NativeImplementationProvider().resolve(definition.implementation),
    ).rejects.toMatchObject({
      code: 'NotFound',
      details: { kind: 'implementation-artifact' },
    });
  });

  it('a different handler for the same artifact is rejected (immutable artifacts)', () => {
    const handlers = new InMemoryHandlerRegistry();
    handlers.register(artifact, handler);
    handlers.register(artifact, handler);
    try {
      handlers.register(artifact, { handle: handler.handle });
      expect.fail('expected InvalidConfiguration');
    } catch (err) {
      expect(isAgentropyError(err, 'InvalidConfiguration')).toBe(true);
    }
  });

  it('unregistering an artifact after acceptance fails the next activation with IncompatibleVersion (AC-10 provider part)', async () => {
    const handlers = new InMemoryHandlerRegistry();
    handlers.register(artifact, handler);
    const provider = new NativeImplementationProvider(handlers);
    const agent = provider.createAgent(
      await provider.resolve(definition.implementation),
    );
    expect(await agent.handle(invocation, ctx)).toEqual({
      kind: 'completed',
      output: { ok: true },
    });
    handlers.unregister(artifact);
    await expect(agent.handle(invocation, ctx)).rejects.toMatchObject({
      code: 'IncompatibleVersion',
    });
  });

  it('acceptance pins the binding; a v2 handler does not change a v1 snapshot', async () => {
    const handlers = new InMemoryHandlerRegistry();
    handlers.register(artifact, handler);
    const providers = new InMemoryImplementationProviderRegistry();
    providers.register(new NativeImplementationProvider(handlers));
    const v1 = await resolveAcceptance(
      {
        definition,
        principal: { id: 'u', type: 'user', tenantId: 't' },
        tenantId: 't',
      },
      env(providers),
    );
    handlers.register({ id: 'expense-approval', version: '2.0.0' }, handler);
    expect(v1.implementation.artifact).toEqual(artifact);
  });

  it('provider registry: unknown provider NotFound; conflicting re-registration rejected', () => {
    const providers = new InMemoryImplementationProviderRegistry();
    expect(() => providers.get('langgraph-js', '0.1.0')).toThrowError(
      /not found/,
    );
    providers.register(new NativeImplementationProvider());
    const odd = Object.assign(new NativeImplementationProvider(), {
      features: {
        ...new NativeImplementationProvider().features,
        isolation: 'sandbox' as const,
      },
    });
    expect(() => providers.register(odd)).toThrowError(/different features/);
  });
});
