/**
 * Pure capability resolution (Capability v1 revision 6, "Resolution algorithm", steps 1–5 and 7).
 * Policy (step 6) and implementation/tool/skill resolution live in acceptance.ts.
 */
import semver from 'semver';
import type {
  AgentDefinition,
  DurabilityLevel,
  VersionedRef,
} from './agent.js';
import type {
  AgentProfile,
  CapabilityBinding,
  CapabilityContract,
  CapabilitySelection,
} from './capability.js';
import { DURABILITY_LEVELS } from './catalog.js';
import { AgentropyError } from './errors.js';
import { validateAgainst } from './schemas.js';

export interface CapabilityProviderDescriptor {
  id: string;
  version: string;
  contracts: { id: string; version: string; level?: string }[];
}

export interface CapabilityEnvironment {
  contracts: readonly CapabilityContract[];
  profiles: readonly AgentProfile[];
  providers: readonly CapabilityProviderDescriptor[];
  /** Deployment default provider per capability ID; used when a selection names none and several match. */
  defaultProviders?: Readonly<Record<string, string>>;
  /** Strongest durability level the runtime/store itself can honor. */
  runtimeDurability: DurabilityLevel;
}

export interface CapabilityResolution {
  profile: AgentProfile;
  bindings: CapabilityBinding[];
  /** Strongest requested durability level, or the runtime level when nothing was requested. */
  durability: DurabilityLevel;
  requestedDurability?: DurabilityLevel;
}

interface Working {
  id: string;
  ranges: string[];
  required: boolean;
  config: Record<string, unknown>;
  providerId?: string;
  level?: string;
}

const fail = (
  code:
    | 'InvalidConfiguration'
    | 'CapabilityUnavailable'
    | 'GuaranteeUnavailable'
    | 'NotFound',
  message: string,
  details: Record<string, unknown>,
) => new AgentropyError(code, message, { details });

function levelRank(
  contract: CapabilityContract,
  level: string | undefined,
): number {
  if (level === undefined) return -1;
  const rank = (contract.levels ?? []).indexOf(level);
  if (rank < 0)
    throw fail(
      'InvalidConfiguration',
      `Unknown level ${level} for ${contract.id}`,
      { reason: 'level', id: contract.id, level },
    );
  return rank;
}

function contractsFor(
  env: CapabilityEnvironment,
  id: string,
): CapabilityContract[] {
  return env.contracts.filter((c) => c.id === id);
}

export function findProfile(
  env: Pick<CapabilityEnvironment, 'profiles'>,
  ref: VersionedRef,
): AgentProfile {
  const profile = env.profiles.find(
    (p) => p.id === ref.id && p.version === ref.version,
  );
  if (!profile)
    throw fail('NotFound', `Profile ${ref.id}@${ref.version} not found`, {
      kind: 'profile',
      id: ref.id,
    });
  return profile;
}

/** Steps 1–5: merge, expand dependencies, resolve versions/providers/config, verify guarantees. */
export function resolveCapabilities(
  definition: AgentDefinition,
  env: CapabilityEnvironment,
  instanceSelections: readonly CapabilitySelection[] = [],
): CapabilityResolution {
  // Step 1: exact profile.
  const profile = findProfile(env, definition.profile);
  const working = new Map<string, Working>();

  const apply = (s: CapabilitySelection, required: boolean) => {
    const contracts = contractsFor(env, s.id);
    if (contracts.length === 0)
      throw fail('CapabilityUnavailable', `Unknown capability ${s.id}`, {
        reason: 'unknown',
        id: s.id,
      });
    const existing = working.get(s.id);
    if (s.remove) {
      if (existing?.required)
        throw fail(
          'InvalidConfiguration',
          `Required capability ${s.id} cannot be removed`,
          { reason: 'required-removal', id: s.id },
        );
      working.delete(s.id);
      return;
    }
    if (!existing) {
      working.set(s.id, {
        id: s.id,
        ranges: [s.versionRange],
        required,
        config: { ...(s.config ?? {}) },
        providerId: s.providerId,
        level: s.level,
      });
      return;
    }
    // Nearer selection overrides ordinary config/provider; ranges accumulate; guarantee level only strengthens.
    existing.ranges.push(s.versionRange);
    existing.required ||= required;
    if (s.config) existing.config = { ...existing.config, ...s.config };
    if (s.providerId) existing.providerId = s.providerId;
    if (s.level !== undefined) {
      const contract = contracts[0]!;
      if (levelRank(contract, s.level) > levelRank(contract, existing.level))
        existing.level = s.level;
    }
  };

  // Step 2: profile required + defaults, then definition, runtime requirements, then instance.
  for (const s of profile.required) apply(s, true);
  for (const s of profile.defaults) apply(s, false);
  for (const s of definition.capabilities ?? []) apply(s, false);
  for (const s of definition.runtimeRequirements.guarantees) apply(s, false);
  for (const s of instanceSelections) apply(s, false);

  // Step 3: dependencies (transitive), cycles and conflicts over the contract graph.
  const visiting = new Set<string>();
  const done = new Set<string>();
  const visit = (id: string, path: string[]) => {
    if (done.has(id)) return;
    if (visiting.has(id))
      throw fail(
        'InvalidConfiguration',
        `Capability dependency cycle ${[...path, id].join(' → ')}`,
        { reason: 'cycle', id },
      );
    visiting.add(id);
    for (const c of contractsFor(env, id)) {
      for (const dep of c.dependencies) {
        if (contractsFor(env, dep.id).length === 0)
          throw fail(
            'CapabilityUnavailable',
            `Unknown dependency ${dep.id} of ${id}`,
            { reason: 'unknown', id: dep.id },
          );
        const w = working.get(dep.id);
        if (w) w.ranges.push(dep.versionRange);
        else
          working.set(dep.id, {
            id: dep.id,
            ranges: [dep.versionRange],
            required: true,
            config: {},
          });
        visit(dep.id, [...path, id]);
      }
    }
    visiting.delete(id);
    done.add(id);
  };
  for (const id of [...working.keys()]) visit(id, []);

  // Step 4: exact versions, providers, config.
  const bindings: CapabilityBinding[] = [];
  let requestedDurability: DurabilityLevel | undefined;
  for (const w of [...working.values()].sort((a, b) =>
    a.id.localeCompare(b.id),
  )) {
    const candidates = contractsFor(env, w.id)
      .filter((c) => w.ranges.every((r) => semver.satisfies(c.version, r)))
      .sort((a, b) => semver.rcompare(a.version, b.version));
    const contract = candidates[0];
    if (!contract)
      throw fail(
        'CapabilityUnavailable',
        `No version of ${w.id} satisfies ${w.ranges.join(' and ')}`,
        { reason: 'version', id: w.id },
      );

    for (const conflict of contract.conflicts ?? []) {
      const other = working.get(conflict.id);
      if (other)
        throw fail(
          'InvalidConfiguration',
          `${w.id} conflicts with ${conflict.id}`,
          { reason: 'conflict', id: w.id, with: conflict.id },
        );
    }

    const matching = env.providers.filter((p) =>
      p.contracts.some(
        (c) => c.id === contract.id && c.version === contract.version,
      ),
    );
    let provider: CapabilityProviderDescriptor | undefined;
    if (w.providerId) {
      provider = matching.find((p) => p.id === w.providerId);
      if (!provider)
        throw fail(
          'CapabilityUnavailable',
          `Provider ${w.providerId} does not offer ${w.id}@${contract.version}`,
          { reason: 'provider', id: w.id },
        );
    } else if (matching.length === 1) {
      provider = matching[0];
    } else if (matching.length > 1) {
      const preferred = env.defaultProviders?.[w.id];
      provider = matching.find((p) => p.id === preferred);
      if (!provider)
        throw fail('CapabilityUnavailable', `Ambiguous provider for ${w.id}`, {
          reason: 'ambiguous',
          id: w.id,
          candidates: matching.map((p) => p.id),
        });
    } else {
      throw fail(
        'CapabilityUnavailable',
        `No provider for ${w.id}@${contract.version}`,
        { reason: 'provider', id: w.id },
      );
    }

    try {
      validateAgainst(contract.configSchema, w.config, `${w.id} config`);
    } catch (cause) {
      throw new AgentropyError(
        'InvalidConfiguration',
        `Invalid config for ${w.id}`,
        { details: { reason: 'config', id: w.id }, cause },
      );
    }

    const binding: CapabilityBinding = {
      id: w.id,
      version: contract.version,
      providerId: provider.id,
      providerVersion: provider.version,
      config: w.config,
    };

    // Step 5: guarantees — the provided level is the weaker of provider and runtime.
    if (contract.kind === 'guarantee') {
      const requested = levelRank(contract, w.level);
      let provided = levelRank(
        contract,
        provider.contracts.find((c) => c.id === contract.id)?.level ??
          contract.levels?.[0],
      );
      if (contract.id === 'durability')
        provided = Math.min(
          provided,
          DURABILITY_LEVELS.indexOf(env.runtimeDurability),
        );
      if (provided < requested) {
        throw fail(
          'GuaranteeUnavailable',
          `${w.id} level ${w.level} is not available`,
          {
            id: w.id,
            requested: w.level ?? 'none',
            provided: contract.levels?.[provided] ?? 'none',
          },
        );
      }
      binding.level = contract.levels?.[provided];
      if (contract.id === 'durability' && w.level !== undefined)
        requestedDurability = w.level as DurabilityLevel;
    }
    bindings.push(binding);
  }

  return {
    profile,
    bindings,
    durability: requestedDurability ?? env.runtimeDurability,
    requestedDurability,
  };
}
