/**
 * Acceptance resolution (Agent v1 revision 7): definition → profile/capabilities → implementation →
 * tools → skills → capability policy → immutable, redacted AcceptanceSnapshot. First failure wins;
 * optional tool/skill failures are omitted and recorded (except PolicyDecisionUnavailable, which fails closed).
 */
import { createHash } from 'node:crypto';
import semver from 'semver';
import type {
  AcceptanceSnapshot,
  AgentDefinition,
  OmittedSelection,
  TrustedPrincipal,
} from './agent.js';
import type { CapabilitySelection } from './capability.js';
import { AgentropyError, isAgentropyError } from './errors.js';
import type {
  AgentImplementationProvider,
  ImplementationBinding,
} from './implementation.js';
import { type CapabilityEnvironment, resolveCapabilities } from './resolver.js';
import { validateAgentDefinition } from './schemas.js';
import type { PolicyDecisionPoint, PolicyRequest } from './security.js';
import type { SkillPin, SkillRecord } from './skill.js';
import type { ToolPin, ToolRecord } from './tool.js';

export interface AcceptanceEnvironment extends CapabilityEnvironment {
  implementationProvider(
    providerId: string,
    providerVersion: string,
  ): AgentImplementationProvider | undefined;
  /** All registered versions of a tool (any status). */
  toolVersions(id: string): readonly ToolRecord[];
  toolProviderRegistered(providerId: string, providerVersion: string): boolean;
  /** All registered versions of a skill (any status). */
  skillVersions(id: string): readonly SkillRecord[];
  pdp: PolicyDecisionPoint;
  now(): string;
}

export interface AcceptanceRequest {
  definition: AgentDefinition;
  principal: TrustedPrincipal;
  tenantId: string;
  instanceSelections?: readonly CapabilitySelection[];
}

const canonical = (value: unknown): string =>
  JSON.stringify(value, (_k, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
            a.localeCompare(b),
          ),
        )
      : v,
  );

export const digestOf = (value: unknown): string =>
  `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`;

/** Policy enforcement point (Security v1): tenant check, then PDP; any PDP failure is PolicyDecisionUnavailable. */
export async function enforcePolicy(
  pdp: PolicyDecisionPoint,
  request: PolicyRequest,
  signal?: AbortSignal,
): Promise<void> {
  if (request.principal.tenantId !== request.resource.tenantId) {
    throw new AgentropyError('TenantMismatch', 'Cross-tenant access denied', {
      details: { action: request.action },
    });
  }
  let decision: unknown;
  try {
    decision = await pdp.decide(request, signal);
  } catch (cause) {
    throw new AgentropyError(
      'PolicyDecisionUnavailable',
      'Policy decision unavailable',
      { details: { action: request.action }, cause },
    );
  }
  const effect = (decision as { effect?: unknown } | null | undefined)?.effect;
  if (effect === 'allow') return;
  if (effect === 'deny')
    throw new AgentropyError('PermissionDenied', 'Permission denied', {
      details: { action: request.action },
    });
  throw new AgentropyError(
    'PolicyDecisionUnavailable',
    'Indeterminate policy decision',
    { details: { action: request.action } },
  );
}

async function resolveImplementation(
  def: AgentDefinition,
  env: AcceptanceEnvironment,
  tenantId: string,
  durability: string | undefined,
): Promise<ImplementationBinding> {
  const ref = def.implementation;
  const provider = env.implementationProvider(
    ref.providerId,
    ref.providerVersion,
  );
  if (!provider) {
    throw new AgentropyError(
      'NotFound',
      `Implementation provider ${ref.providerId}@${ref.providerVersion} not found`,
      {
        details: { kind: 'implementation-provider', id: ref.providerId },
      },
    );
  }
  const binding = await provider.resolve(ref, { tenantId });
  if (
    durability === 'durable-execution' &&
    !binding.features.checkpointResume
  ) {
    throw new AgentropyError(
      'GuaranteeUnavailable',
      `${ref.providerId} cannot resume from checkpoints`,
      { details: { feature: 'checkpointResume' } },
    );
  }
  if (binding.features.remoteAuthority) {
    throw new AgentropyError(
      'UnsupportedOperation',
      'Remote-authority implementations are not supported in M1',
      { details: { feature: 'remoteAuthority' } },
    );
  }
  return binding;
}

function highestActive<T extends { status: string }>(
  records: readonly T[],
  version: (r: T) => string,
  range: string,
): T | undefined {
  return records
    .filter((r) => r.status === 'active' && semver.satisfies(version(r), range))
    .sort((a, b) => semver.rcompare(version(a), version(b)))[0];
}

async function resolveTool(
  sel: NonNullable<AgentDefinition['tools']>[number],
  env: AcceptanceEnvironment,
  req: AcceptanceRequest,
): Promise<ToolPin> {
  const record = highestActive(
    env.toolVersions(sel.id),
    (r) => r.descriptor.version,
    sel.versionRange,
  );
  if (!record)
    throw new AgentropyError(
      'CapabilityUnavailable',
      `No active version of tool ${sel.id} in ${sel.versionRange}`,
      { details: { kind: 'tool', id: sel.id } },
    );
  const bindings = record.bindings;
  const binding = sel.bindingId
    ? bindings.find((b) => b.bindingId === sel.bindingId)
    : bindings.length === 1
      ? bindings[0]
      : bindings.filter((b) => b.default).length === 1
        ? bindings.find((b) => b.default)
        : undefined;
  if (
    !binding ||
    !env.toolProviderRegistered(binding.providerId, binding.providerVersion)
  ) {
    throw new AgentropyError(
      'CapabilityUnavailable',
      `No usable binding for tool ${sel.id}`,
      {
        details: {
          kind: 'tool',
          id: sel.id,
          reason:
            bindings.length > 1 && !sel.bindingId ? 'ambiguous' : 'binding',
        },
      },
    );
  }
  await enforcePolicy(env.pdp, {
    principal: req.principal,
    action: record.descriptor.permission,
    resource: { type: 'tool', id: sel.id, tenantId: req.tenantId },
  });
  return {
    toolId: record.descriptor.id,
    toolVersion: record.descriptor.version,
    bindingId: binding.bindingId,
    providerId: binding.providerId,
    providerVersion: binding.providerVersion,
    digest: record.provenance.digest,
  };
}

function resolveSkill(
  sel: NonNullable<AgentDefinition['skills']>[number],
  env: AcceptanceEnvironment,
  capabilityIds: Set<string>,
  tools: ToolPin[],
): SkillPin {
  const record = highestActive(
    env.skillVersions(sel.id),
    (r) => r.version,
    sel.versionRange,
  );
  if (!record)
    throw new AgentropyError(
      'CapabilityUnavailable',
      `No active version of skill ${sel.id} in ${sel.versionRange}`,
      { details: { kind: 'skill', id: sel.id } },
    );
  for (const cap of record.requires.capabilities ?? []) {
    if (!capabilityIds.has(cap.id)) {
      throw new AgentropyError(
        'CapabilityUnavailable',
        `Skill ${sel.id} requires capability ${cap.id}`,
        {
          details: {
            kind: 'skill',
            reason: 'dependency',
            id: sel.id,
            missing: cap.id,
          },
        },
      );
    }
  }
  for (const tool of record.requires.tools ?? []) {
    if (
      !tools.some(
        (t) =>
          t.toolId === tool.id &&
          semver.satisfies(t.toolVersion, tool.versionRange),
      )
    ) {
      throw new AgentropyError(
        'CapabilityUnavailable',
        `Skill ${sel.id} requires tool ${tool.id}`,
        {
          details: {
            kind: 'skill',
            reason: 'dependency',
            id: sel.id,
            missing: tool.id,
          },
        },
      );
    }
  }
  return { id: record.id, version: record.version, digest: record.digest };
}

/** Optional selections tolerate typed resolution failures (recorded), never a PDP outage or an internal bug. */
function omittable(err: unknown): err is AgentropyError {
  return (
    isAgentropyError(err) &&
    err.code !== 'PolicyDecisionUnavailable' &&
    err.code !== 'Internal'
  );
}

export async function resolveAcceptance(
  req: AcceptanceRequest,
  env: AcceptanceEnvironment,
): Promise<AcceptanceSnapshot> {
  const def = validateAgentDefinition(req.definition);
  const caps = resolveCapabilities(def, env, req.instanceSelections);
  const implementation = await resolveImplementation(
    def,
    env,
    req.tenantId,
    caps.requestedDurability,
  );
  // Without checkpoint resume an activation can only be re-run from scratch: disclose at most durable-acceptance.
  const durability =
    caps.durability === 'durable-execution' &&
    !implementation.features.checkpointResume
      ? 'durable-acceptance'
      : caps.durability;
  const capabilityIds = new Set(caps.bindings.map((b) => b.id));
  const omitted: OmittedSelection[] = [];

  const tools: ToolPin[] = [];
  if ((def.tools ?? []).length > 0 && !capabilityIds.has('tool-use')) {
    throw new AgentropyError(
      'InvalidConfiguration',
      'Tools are selected but tool-use is not in the effective capability set',
      { details: { reason: 'tool-use' } },
    );
  }
  for (const sel of def.tools ?? []) {
    try {
      tools.push(await resolveTool(sel, env, req));
    } catch (err) {
      if (sel.required === false && omittable(err))
        omitted.push({ kind: 'tool', id: sel.id, code: err.code });
      else throw err;
    }
  }

  const skills: SkillPin[] = [];
  for (const sel of def.skills ?? []) {
    try {
      skills.push(resolveSkill(sel, env, capabilityIds, tools));
    } catch (err) {
      if (sel.required === false && omittable(err))
        omitted.push({ kind: 'skill', id: sel.id, code: err.code });
      else throw err;
    }
  }

  // Step 6: intersect behavior capabilities with current policy (no escalation by configuration).
  for (const b of caps.bindings) {
    if (b.id === 'durability') continue;
    await enforcePolicy(env.pdp, {
      principal: req.principal,
      action: `capability:${b.id}:use`,
      resource: { type: 'capability', id: b.id, tenantId: req.tenantId },
    });
  }

  const pinned = {
    definition: { id: def.id, version: def.version },
    profile: { id: caps.profile.id, version: caps.profile.version },
    policyRef: def.policyRef,
    implementation,
    bindings: caps.bindings,
    durability,
    tools,
    skills,
    omitted,
  };
  return { snapshotId: digestOf(pinned), resolvedAt: env.now(), ...pinned };
}
