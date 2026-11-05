// AC-16 (resolver part) and D-01: capability catalog, built-in profiles and capability resolution.
// The "missing step key on an external op" case of AC-16 is an invocation-time check (CapabilityAccess/ToolExecutor).
import { describe, expect, it } from 'vitest';
import type { AgentDefinition, DurabilityLevel } from '../src/agent.js';
import type { CapabilityContract } from '../src/capability.js';
import { BUILTIN_PROFILES, CAPABILITY_CATALOG } from '../src/catalog.js';
import { isAgentropyError } from '../src/errors.js';
import {
  type CapabilityEnvironment,
  type CapabilityProviderDescriptor,
  resolveCapabilities,
} from '../src/resolver.js';

const builtin: CapabilityProviderDescriptor = {
  id: 'builtin',
  version: '1.0.0',
  contracts: CAPABILITY_CATALOG.map((c) => ({
    id: c.id,
    version: c.version,
    ...(c.id === 'durability' ? { level: 'durable-execution' } : {}),
  })),
};

const env = (
  over: Partial<CapabilityEnvironment> = {},
): CapabilityEnvironment => ({
  contracts: CAPABILITY_CATALOG,
  profiles: BUILTIN_PROFILES,
  providers: [builtin],
  runtimeDurability: 'durable-execution',
  ...over,
});

const def = (
  profile: string,
  over: Partial<AgentDefinition> = {},
): AgentDefinition => ({
  id: `${profile}-agent`,
  version: '1.0.0',
  displayName: profile,
  profile: { id: profile, version: '1.0.0' },
  implementation: {
    providerId: 'native-ts',
    providerVersion: '1.0.0',
    artifact: { id: `${profile}-agent`, version: '1.0.0' },
  },
  inputSchema: true,
  runtimeRequirements: { guarantees: [] },
  policyRef: { id: 'default', version: '1.0.0' },
  ...over,
});

const ids = (d: AgentDefinition, e = env()) =>
  resolveCapabilities(d, e).bindings.map((b) => b.id);

function expectError(
  fn: () => unknown,
  code: string,
  details?: Record<string, unknown>,
) {
  try {
    fn();
    expect.fail(`expected ${code}`);
  } catch (err) {
    expect(isAgentropyError(err), String(err)).toBe(true);
    expect((err as { code: string }).code).toBe(code);
    if (details)
      expect((err as { details: unknown }).details).toMatchObject(details);
  }
}

describe('built-in profiles (Capability v1 profile defaults, D-01)', () => {
  it.each([
    [
      'conversational',
      ['conversation', 'delegation', 'durability', 'session-context'],
      'durable-acceptance',
    ],
    ['task', ['durability', 'notification'], 'durable-execution'],
    [
      'monitoring',
      ['durability', 'event-handling', 'notification', 'scheduling'],
      'durable-execution',
    ],
    [
      'coordinator',
      ['delegation', 'durability', 'notification'],
      'durable-execution',
    ],
    ['specialist', ['tool-use'], undefined],
    ['generic', [], undefined],
  ])('%s resolves required + defaults', (profile, expected, durability) => {
    const r = resolveCapabilities(def(profile), env());
    expect(r.bindings.map((b) => b.id)).toEqual(expected);
    expect(r.requestedDurability).toBe(durability);
  });

  it('task agents require durable-execution even without scheduling (ADR-0019)', () => {
    expectError(
      () =>
        resolveCapabilities(
          def('task'),
          env({ runtimeDurability: 'durable-acceptance' }),
        ),
      'GuaranteeUnavailable',
      {
        requested: 'durable-execution',
        provided: 'durable-acceptance',
      },
    );
    expect(ids(def('task'))).not.toContain('scheduling');
  });
});

describe('capability resolution (AC-16)', () => {
  it('removing a required capability fails InvalidConfiguration', () => {
    expectError(
      () =>
        resolveCapabilities(
          def('monitoring', {
            capabilities: [
              { id: 'event-handling', versionRange: '^1.0.0', remove: true },
            ],
          }),
          env(),
        ),
      'InvalidConfiguration',
      { reason: 'required-removal' },
    );
  });

  it('removing a default is allowed; optional additions merge', () => {
    const d = def('task', {
      capabilities: [
        { id: 'notification', versionRange: '^1.0.0', remove: true },
        { id: 'human-input', versionRange: '^1.0.0' },
      ],
    });
    expect(ids(d)).toEqual(['durability', 'human-input']);
  });

  it('an unknown capability ID fails CapabilityUnavailable', () => {
    expectError(
      () =>
        resolveCapabilities(
          def('generic', {
            capabilities: [{ id: 'teleport', versionRange: '^1.0.0' }],
          }),
          env(),
        ),
      'CapabilityUnavailable',
      {
        reason: 'unknown',
      },
    );
  });

  it('a dependency cycle fails InvalidConfiguration', () => {
    const a: CapabilityContract = {
      id: 'a',
      version: '1.0.0',
      kind: 'behavior',
      configSchema: true,
      dependencies: [{ id: 'b', versionRange: '^1.0.0' }],
      operations: [],
    };
    const b: CapabilityContract = {
      ...a,
      id: 'b',
      dependencies: [{ id: 'a', versionRange: '^1.0.0' }],
    };
    const provider = {
      id: 'p',
      version: '1.0.0',
      contracts: [
        { id: 'a', version: '1.0.0' },
        { id: 'b', version: '1.0.0' },
      ],
    };
    expectError(
      () =>
        resolveCapabilities(
          def('generic', {
            capabilities: [{ id: 'a', versionRange: '^1.0.0' }],
          }),
          env({
            contracts: [...CAPABILITY_CATALOG, a, b],
            providers: [builtin, provider],
          }),
        ),
      'InvalidConfiguration',
      { reason: 'cycle' },
    );
  });

  it('dependencies are expanded transitively and conflicts are rejected', () => {
    const a: CapabilityContract = {
      id: 'a',
      version: '1.0.0',
      kind: 'behavior',
      configSchema: true,
      dependencies: [{ id: 'reasoning', versionRange: '^1.0.0' }],
      operations: [],
    };
    const c: CapabilityContract = {
      ...a,
      id: 'c',
      dependencies: [],
      conflicts: [{ id: 'a', versionRange: '*' }],
    };
    const provider = {
      id: 'p',
      version: '1.0.0',
      contracts: [
        { id: 'a', version: '1.0.0' },
        { id: 'c', version: '1.0.0' },
      ],
    };
    const e = env({
      contracts: [...CAPABILITY_CATALOG, a, c],
      providers: [builtin, provider],
    });
    expect(
      ids(
        def('generic', { capabilities: [{ id: 'a', versionRange: '^1.0.0' }] }),
        e,
      ),
    ).toEqual(['a', 'reasoning']);
    expectError(
      () =>
        resolveCapabilities(
          def('generic', {
            capabilities: [
              { id: 'a', versionRange: '^1.0.0' },
              { id: 'c', versionRange: '^1.0.0' },
            ],
          }),
          e,
        ),
      'InvalidConfiguration',
      { reason: 'conflict' },
    );
  });

  it('resolves the highest contract version satisfying every range and rejects unsatisfiable ranges', () => {
    const v2: CapabilityContract = {
      ...CAPABILITY_CATALOG.find((c) => c.id === 'memory')!,
      version: '2.0.0',
    };
    const p2 = {
      id: 'mem2',
      version: '1.0.0',
      contracts: [{ id: 'memory', version: '2.0.0' }],
    };
    const e = env({
      contracts: [...CAPABILITY_CATALOG, v2],
      providers: [builtin, p2],
    });
    expect(
      resolveCapabilities(
        def('generic', {
          capabilities: [{ id: 'memory', versionRange: '>=1.0.0' }],
        }),
        e,
      ).bindings[0],
    ).toMatchObject({
      version: '2.0.0',
      providerId: 'mem2',
    });
    expectError(
      () =>
        resolveCapabilities(
          def('generic', {
            capabilities: [{ id: 'memory', versionRange: '^3.0.0' }],
          }),
          e,
        ),
      'CapabilityUnavailable',
      {
        reason: 'version',
      },
    );
  });

  it('an ambiguous provider fails unless explicit or a deployment default exists', () => {
    const other = {
      id: 'other',
      version: '2.0.0',
      contracts: [{ id: 'reasoning', version: '1.0.0' }],
    };
    const d = def('generic', {
      capabilities: [{ id: 'reasoning', versionRange: '^1.0.0' }],
    });
    expectError(
      () => resolveCapabilities(d, env({ providers: [builtin, other] })),
      'CapabilityUnavailable',
      { reason: 'ambiguous' },
    );
    expect(
      resolveCapabilities(
        d,
        env({
          providers: [builtin, other],
          defaultProviders: { reasoning: 'other' },
        }),
      ).bindings[0]!.providerId,
    ).toBe('other');
    const explicit = def('generic', {
      capabilities: [
        { id: 'reasoning', versionRange: '^1.0.0', providerId: 'builtin' },
      ],
    });
    expect(
      resolveCapabilities(explicit, env({ providers: [builtin, other] }))
        .bindings[0]!.providerId,
    ).toBe('builtin');
  });

  it('a missing provider fails CapabilityUnavailable', () => {
    expectError(
      () => resolveCapabilities(def('specialist'), env({ providers: [] })),
      'CapabilityUnavailable',
      { reason: 'provider' },
    );
  });

  it('invalid capability config fails InvalidConfiguration', () => {
    const strict: CapabilityContract = {
      ...CAPABILITY_CATALOG.find((c) => c.id === 'memory')!,
      configSchema: {
        type: 'object',
        properties: { ttl: { type: 'integer' } },
      },
    };
    expectError(
      () =>
        resolveCapabilities(
          def('generic', {
            capabilities: [
              {
                id: 'memory',
                versionRange: '^1.0.0',
                config: { ttl: 'forever' },
              },
            ],
          }),
          env({
            contracts: [
              ...CAPABILITY_CATALOG.filter((c) => c.id !== 'memory'),
              strict,
            ],
          }),
        ),
      'InvalidConfiguration',
      { reason: 'config' },
    );
  });

  it('guarantee levels only strengthen and never downgrade a profile requirement', () => {
    const weaker = def('task', {
      runtimeRequirements: {
        guarantees: [
          { id: 'durability', versionRange: '^1.0.0', level: 'none' },
        ],
      },
    });
    expect(resolveCapabilities(weaker, env()).requestedDurability).toBe(
      'durable-execution',
    );
    const stronger = def('conversational', {
      runtimeRequirements: {
        guarantees: [
          {
            id: 'durability',
            versionRange: '^1.0.0',
            level: 'durable-execution',
          },
        ],
      },
    });
    expect(resolveCapabilities(stronger, env()).requestedDurability).toBe(
      'durable-execution',
    );
  });

  it.each<[DurabilityLevel, string]>([
    ['none', 'GuaranteeUnavailable'],
    ['durable-acceptance', 'GuaranteeUnavailable'],
  ])(
    'a %s runtime rejects a monitoring definition (AC-13 resolver part)',
    (runtime, code) => {
      expectError(
        () =>
          resolveCapabilities(
            def('monitoring'),
            env({ runtimeDurability: runtime }),
          ),
        code,
      );
    },
  );

  it('a specialist on a none runtime discloses durability none (AC-13 resolver part)', () => {
    expect(
      resolveCapabilities(def('specialist'), env({ runtimeDurability: 'none' }))
        .durability,
    ).toBe('none');
  });

  it('swapping a provider changes the resolution of new acceptances only (AC-16, R-03)', () => {
    const d = def('generic', {
      capabilities: [{ id: 'reasoning', versionRange: '^1.0.0' }],
    });
    const before = resolveCapabilities(d, env());
    const fake = {
      id: 'fake-model',
      version: '1.0.0',
      contracts: [{ id: 'reasoning', version: '1.0.0' }],
    };
    const after = resolveCapabilities(
      d,
      env({
        providers: [builtin, fake],
        defaultProviders: { reasoning: 'fake-model' },
      }),
    );
    expect(before.bindings[0]!.providerId).toBe('builtin');
    expect(after.bindings[0]!.providerId).toBe('fake-model');
    expect(d.capabilities).toEqual([
      { id: 'reasoning', versionRange: '^1.0.0' },
    ]); // definition unchanged
  });

  it('nearer instance selections override definition config but cannot remove required capabilities', () => {
    const d = def('conversational', {
      capabilities: [
        { id: 'delegation', versionRange: '^1.0.0', config: { maxDepth: 3 } },
      ],
    });
    const r = resolveCapabilities(d, env(), [
      { id: 'delegation', versionRange: '^1.0.0', config: { maxDepth: 2 } },
    ]);
    expect(r.bindings.find((b) => b.id === 'delegation')!.config).toEqual({
      maxDepth: 2,
    });
    expectError(
      () =>
        resolveCapabilities(d, env(), [
          { id: 'conversation', versionRange: '^1.0.0', remove: true },
        ]),
      'InvalidConfiguration',
    );
  });

  it('a missing profile fails NotFound', () => {
    expectError(() => resolveCapabilities(def('ghost'), env()), 'NotFound', {
      kind: 'profile',
    });
  });
});
