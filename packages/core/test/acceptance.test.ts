// CT-ACCEPTANCE: implementation, tool and skill resolution into an AcceptanceSnapshot (A-03).
import { describe, expect, it } from 'vitest';
import {
  type AcceptanceEnvironment,
  enforcePolicy,
  resolveAcceptance,
} from '../src/acceptance.js';
import type { AgentDefinition, TrustedPrincipal } from '../src/agent.js';
import { BUILTIN_PROFILES, CAPABILITY_CATALOG } from '../src/catalog.js';
import { isAgentropyError } from '../src/errors.js';
import type {
  AgentImplementationProvider,
  ImplementationFeatures,
} from '../src/implementation.js';
import type { PolicyDecisionPoint } from '../src/security.js';
import type { SkillRecord } from '../src/skill.js';
import type { ToolRecord } from '../src/tool.js';

const user: TrustedPrincipal = { id: 'u-1', type: 'user', tenantId: 't-1' };
const features: ImplementationFeatures = {
  checkpointResume: true,
  cooperativeCancellation: true,
  progressReporting: true,
  isolation: 'in-process',
  remoteAuthority: false,
};

function implProvider(
  f: Partial<ImplementationFeatures> = {},
  known = ['agent'],
): AgentImplementationProvider {
  return {
    id: 'native-ts',
    version: '1.0.0',
    features: { ...features, ...f },
    async resolve(ref) {
      if (!known.includes(ref.artifact.id))
        throw Object.assign(new Error('x'), { code: 'NotFound' });
      return {
        providerId: 'native-ts',
        providerVersion: '1.0.0',
        artifact: ref.artifact,
        features: { ...features, ...f },
      };
    },
    createAgent: () => ({
      handle: async () => ({ kind: 'completed', output: null }),
    }),
  };
}

const tool = (
  id: string,
  version: string,
  status: ToolRecord['status'] = 'active',
  bindings = [{ id: 'direct', default: true }],
): ToolRecord => ({
  descriptor: {
    id,
    version,
    description: id,
    inputSchema: true,
    effect: 'external',
    idempotency: 'keyed',
    permission: `tool:${id}:call`,
  },
  provenance: {
    publisher: 'acme',
    source: 'test',
    digest: `sha256:${id}@${version}`,
    verified: true,
  },
  bindings: bindings.map((b) => ({
    bindingId: b.id,
    toolId: id,
    toolVersion: version,
    providerId: b.id,
    providerVersion: '1.0.0',
    config: {},
    default: b.default,
  })),
  status,
  revision: 1,
});

const skill = (
  id: string,
  version: string,
  requires: SkillRecord['requires'] = {},
  status: SkillRecord['status'] = 'active',
): SkillRecord => ({
  id,
  version,
  specVersion: 'agentskills-2026-11-05',
  metadata: { name: id, description: id, allowedTools: ['finance.payout'] },
  digest: `sha256:${id}@${version}`,
  provenance: { publisher: 'acme', source: 'test', verified: true },
  requires,
  files: ['SKILL.md'],
  status,
  revision: 1,
});

type PdpMode = 'allow' | 'throw' | 'garbage';
function pdp(
  denied: string[] = [],
  mode: PdpMode = 'allow',
  log: string[] = [],
): PolicyDecisionPoint {
  return {
    async decide(req) {
      log.push(req.action);
      if (mode === 'throw') throw new Error('pdp down');
      if (mode === 'garbage') return { effect: 'maybe' } as never;
      return denied.includes(req.action)
        ? { effect: 'deny' }
        : { effect: 'allow' };
    },
  };
}

function env(
  over: Partial<AcceptanceEnvironment> = {},
  tools: ToolRecord[] = [],
  skills: SkillRecord[] = [],
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
          ...(c.id === 'durability' ? { level: 'durable-execution' } : {}),
        })),
      },
    ],
    runtimeDurability: 'durable-execution',
    implementationProvider: (id, v) =>
      id === 'native-ts' && v === '1.0.0' ? implProvider() : undefined,
    toolVersions: (id) => tools.filter((t) => t.descriptor.id === id),
    toolProviderRegistered: (id) => id === 'direct' || id === 'loopback',
    skillVersions: (id) => skills.filter((s) => s.id === id),
    pdp: pdp(),
    now: () => '2026-11-05T00:00:00.000Z',
    ...over,
  };
}

const def = (over: Partial<AgentDefinition> = {}): AgentDefinition => ({
  id: 'agent',
  version: '1.0.0',
  displayName: 'Agent',
  profile: { id: 'specialist', version: '1.0.0' },
  implementation: {
    providerId: 'native-ts',
    providerVersion: '1.0.0',
    artifact: { id: 'agent', version: '1.0.0' },
  },
  inputSchema: true,
  runtimeRequirements: { guarantees: [] },
  policyRef: { id: 'default', version: '1.0.0' },
  ...over,
});

const accept = (d: AgentDefinition, e: AcceptanceEnvironment) =>
  resolveAcceptance({ definition: d, principal: user, tenantId: 't-1' }, e);

async function expectCode(
  p: Promise<unknown>,
  code: string,
  details?: Record<string, unknown>,
) {
  try {
    await p;
    expect.fail(`expected ${code}`);
  } catch (err) {
    expect(isAgentropyError(err), String(err)).toBe(true);
    expect((err as { code: string }).code).toBe(code);
    if (details)
      expect((err as { details: unknown }).details).toMatchObject(details);
  }
}

describe('AcceptanceSnapshot (CT-ACCEPTANCE)', () => {
  it('a generic deterministic agent needs no model, tool, skill or memory', async () => {
    const snap = await accept(
      def({ profile: { id: 'generic', version: '1.0.0' } }),
      env(),
    );
    expect(snap).toMatchObject({
      bindings: [],
      tools: [],
      skills: [],
      omitted: [],
      definition: { id: 'agent', version: '1.0.0' },
      profile: { id: 'generic' },
    });
    expect(snap.implementation).toMatchObject({
      providerId: 'native-ts',
      artifact: { id: 'agent', version: '1.0.0' },
    });
    expect(snap.snapshotId).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('is deterministic for identical inputs and changes when a pin changes', async () => {
    const tools = [tool('finance.quote', '1.0.0')];
    const d = def({ tools: [{ id: 'finance.quote', versionRange: '^1.0.0' }] });
    const a = await accept(d, env({}, tools));
    const b = await accept(d, env({}, tools));
    expect(a.snapshotId).toBe(b.snapshotId);
    const c = await accept(
      d,
      env({}, [...tools, tool('finance.quote', '1.1.0')]),
    );
    expect(c.tools[0]!.toolVersion).toBe('1.1.0');
    expect(c.snapshotId).not.toBe(a.snapshotId);
  });

  it('rejects an invalid definition before anything else', async () => {
    await expectCode(
      accept({ ...def(), version: 'latest' }, env()),
      'SchemaViolation',
    );
  });
});

describe('implementation resolution (Agent Implementation v1)', () => {
  it('an unknown provider is NotFound', async () => {
    await expectCode(
      accept(
        def({
          implementation: {
            providerId: 'langgraph-js',
            providerVersion: '0.1.0',
            artifact: { id: 'agent', version: '1.0.0' },
          },
        }),
        env(),
      ),
      'NotFound',
      {
        kind: 'implementation-provider',
      },
    );
  });

  it('a durable-execution profile requires checkpoint resume', async () => {
    const e = env({
      implementationProvider: () => implProvider({ checkpointResume: false }),
    });
    await expectCode(
      accept(def({ profile: { id: 'task', version: '1.0.0' } }), e),
      'GuaranteeUnavailable',
      { feature: 'checkpointResume' },
    );
    // A specialist does not request durable-execution; without checkpoint resume it discloses durable-acceptance.
    expect((await accept(def(), e)).durability).toBe('durable-acceptance');
    expect((await accept(def(), env())).durability).toBe('durable-execution');
  });

  it('remote-authority implementations are unsupported in M1', async () => {
    await expectCode(
      accept(
        def(),
        env({
          implementationProvider: () => implProvider({ remoteAuthority: true }),
        }),
      ),
      'UnsupportedOperation',
    );
  });
});

describe('tool resolution (Tool v1)', () => {
  it('pins the highest active version and its default binding', async () => {
    const tools = [
      tool('finance.quote', '1.0.0'),
      tool('finance.quote', '1.2.0'),
      tool('finance.quote', '1.3.0', 'suspended'),
      tool('finance.quote', '2.0.0'),
    ];
    const snap = await accept(
      def({ tools: [{ id: 'finance.quote', versionRange: '^1.0.0' }] }),
      env({}, tools),
    );
    expect(snap.tools).toEqual([
      {
        toolId: 'finance.quote',
        toolVersion: '1.2.0',
        bindingId: 'direct',
        providerId: 'direct',
        providerVersion: '1.0.0',
        digest: 'sha256:finance.quote@1.2.0',
      },
    ]);
  });

  it('requires tool-use in the effective capability set', async () => {
    await expectCode(
      accept(
        def({
          profile: { id: 'generic', version: '1.0.0' },
          tools: [{ id: 'finance.quote', versionRange: '*' }],
        }),
        env({}, [tool('finance.quote', '1.0.0')]),
      ),
      'InvalidConfiguration',
    );
  });

  it('a missing required tool fails; a missing optional tool is omitted', async () => {
    await expectCode(
      accept(def({ tools: [{ id: 'ghost', versionRange: '*' }] }), env()),
      'CapabilityUnavailable',
      { kind: 'tool' },
    );
    const snap = await accept(
      def({ tools: [{ id: 'ghost', versionRange: '*', required: false }] }),
      env(),
    );
    expect(snap.omitted).toEqual([
      { kind: 'tool', id: 'ghost', code: 'CapabilityUnavailable' },
    ]);
  });

  it('a registered-but-not-active (discovery-only) tool is not resolvable', async () => {
    await expectCode(
      accept(
        def({ tools: [{ id: 'x.y', versionRange: '*' }] }),
        env({}, [tool('x.y', '1.0.0', 'registered')]),
      ),
      'CapabilityUnavailable',
    );
  });

  it('ambiguous bindings fail unless one is chosen explicitly', async () => {
    const t = tool('x.y', '1.0.0', 'active', [
      { id: 'direct', default: false },
      { id: 'loopback', default: false },
    ]);
    await expectCode(
      accept(def({ tools: [{ id: 'x.y', versionRange: '*' }] }), env({}, [t])),
      'CapabilityUnavailable',
      { reason: 'ambiguous' },
    );
    const snap = await accept(
      def({ tools: [{ id: 'x.y', versionRange: '*', bindingId: 'loopback' }] }),
      env({}, [t]),
    );
    expect(snap.tools[0]!.providerId).toBe('loopback');
  });

  it('policy denial of a required tool is PermissionDenied; of an optional tool it is omitted', async () => {
    const e = env({ pdp: pdp(['tool:x.y:call']) }, [tool('x.y', '1.0.0')]);
    await expectCode(
      accept(def({ tools: [{ id: 'x.y', versionRange: '*' }] }), e),
      'PermissionDenied',
    );
    expect(
      (
        await accept(
          def({ tools: [{ id: 'x.y', versionRange: '*', required: false }] }),
          e,
        )
      ).omitted,
    ).toEqual([{ kind: 'tool', id: 'x.y', code: 'PermissionDenied' }]);
  });

  it('a PDP outage fails closed even for an optional tool (ADR-0025)', async () => {
    const e = env({ pdp: pdp([], 'throw') }, [tool('x.y', '1.0.0')]);
    await expectCode(
      accept(
        def({ tools: [{ id: 'x.y', versionRange: '*', required: false }] }),
        e,
      ),
      'PolicyDecisionUnavailable',
    );
  });
});

describe('skill resolution (Skill v1)', () => {
  it('pins the highest active version with its digest', async () => {
    const snap = await accept(
      def({ skills: [{ id: 'pdf-processing', versionRange: '^1.0.0' }] }),
      env(
        {},
        [],
        [
          skill('pdf-processing', '1.0.0'),
          skill('pdf-processing', '1.4.0'),
          skill('pdf-processing', '1.5.0', {}, 'revoked'),
        ],
      ),
    );
    expect(snap.skills).toEqual([
      {
        id: 'pdf-processing',
        version: '1.4.0',
        digest: 'sha256:pdf-processing@1.4.0',
      },
    ]);
  });

  it('checks declared dependencies without granting them', async () => {
    const s = skill('payouts', '1.0.0', {
      capabilities: [{ id: 'human-input', versionRange: '^1.0.0' }],
      tools: [{ id: 'finance.payout', versionRange: '^1.0.0' }],
    });
    await expectCode(
      accept(
        def({ skills: [{ id: 'payouts', versionRange: '*' }] }),
        env({}, [], [s]),
      ),
      'CapabilityUnavailable',
      { reason: 'dependency', missing: 'human-input' },
    );
    const withCap = def({
      capabilities: [{ id: 'human-input', versionRange: '^1.0.0' }],
      skills: [{ id: 'payouts', versionRange: '*' }],
    });
    await expectCode(
      accept(withCap, env({}, [], [s])),
      'CapabilityUnavailable',
      { missing: 'finance.payout' },
    );
    const ok = await accept(
      { ...withCap, tools: [{ id: 'finance.payout', versionRange: '^1.0.0' }] },
      env({}, [tool('finance.payout', '1.0.0')], [s]),
    );
    expect(ok.skills.map((p) => p.id)).toEqual(['payouts']);
  });

  it("a skill's allowed-tools never makes a tool visible", async () => {
    const snap = await accept(
      def({ skills: [{ id: 'payouts', versionRange: '*' }] }),
      env({}, [tool('finance.payout', '1.0.0')], [skill('payouts', '1.0.0')]),
    );
    expect(snap.tools).toEqual([]);
  });

  it('a missing optional skill is omitted; a missing required skill fails', async () => {
    expect(
      (
        await accept(
          def({
            skills: [{ id: 'ghost', versionRange: '*', required: false }],
          }),
          env(),
        )
      ).omitted,
    ).toEqual([{ kind: 'skill', id: 'ghost', code: 'CapabilityUnavailable' }]);
    await expectCode(
      accept(def({ skills: [{ id: 'ghost', versionRange: '*' }] }), env()),
      'CapabilityUnavailable',
      { kind: 'skill' },
    );
  });
});

describe('capability policy intersection and the PEP', () => {
  it('a capability the principal may not use rejects acceptance (no escalation by configuration)', async () => {
    await expectCode(
      accept(def(), env({ pdp: pdp(['capability:tool-use:use']) })),
      'PermissionDenied',
    );
  });

  it('enforcePolicy checks tenant before calling the PDP and fails closed on malformed decisions', async () => {
    const log: string[] = [];
    await expectCode(
      enforcePolicy(pdp([], 'allow', log), {
        principal: user,
        action: 'a',
        resource: { type: 'x', id: '1', tenantId: 't-2' },
      }),
      'TenantMismatch',
    );
    expect(log).toEqual([]);
    await expectCode(
      enforcePolicy(pdp([], 'garbage'), {
        principal: user,
        action: 'a',
        resource: { type: 'x', id: '1', tenantId: 't-1' },
      }),
      'PolicyDecisionUnavailable',
    );
  });
});
