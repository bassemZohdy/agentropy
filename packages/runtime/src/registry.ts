/** Definition registry, instance directory and discovery (M1-03, R-01, R-06, AC-15). In-memory for M1. */
import {
  AgentropyError,
  INSTANCE_MACHINE,
  assertTransition,
  digestOf,
  enforcePolicy,
  isAgentropyError,
  validateAgentDefinition,
  type AgentDefinition,
  type AgentInstance,
  type AgentProfile,
  type PolicyDecisionPoint,
  type TrustedPrincipal,
  type VersionedRef,
} from '@agentropy/core';
import semver from 'semver';

export interface DiscoveryQuery {
  id?: string;
  capability?: string;
  profile?: string;
  text?: string;
}

export class DefinitionRegistry {
  private readonly byKey = new Map<
    string,
    { definition: AgentDefinition; digest: string }
  >();

  constructor(private readonly profiles: readonly AgentProfile[]) {}

  /** Immutable registration: identical content is a no-op, different content for the same id@version is rejected. */
  register(definition: AgentDefinition): AgentDefinition {
    const def = validateAgentDefinition(structuredClone(definition));
    const key = `${def.id}@${def.version}`;
    const digest = digestOf(def);
    const existing = this.byKey.get(key);
    if (existing) {
      if (existing.digest === digest)
        return structuredClone(existing.definition);
      throw new AgentropyError(
        'InvalidConfiguration',
        `${key} is already registered with different content`,
        { details: { reason: 'immutable', id: def.id } },
      );
    }
    this.byKey.set(key, { definition: Object.freeze(def), digest });
    return structuredClone(def);
  }

  get(ref: VersionedRef): AgentDefinition | undefined {
    const hit = this.byKey.get(`${ref.id}@${ref.version}`);
    return hit ? structuredClone(hit.definition) : undefined;
  }

  require(ref: VersionedRef): AgentDefinition {
    const def = this.get(ref);
    if (!def)
      throw new AgentropyError(
        'NotFound',
        `Definition ${ref.id}@${ref.version} not found`,
        { details: { kind: 'definition', id: ref.id } },
      );
    return def;
  }

  versions(id: string): string[] {
    return [...this.byKey.values()]
      .filter((e) => e.definition.id === id)
      .map((e) => e.definition.version)
      .sort(semver.rcompare);
  }

  /** Capability IDs a definition declares (profile required/defaults plus additions, minus removals). */
  declaredCapabilities(def: AgentDefinition): string[] {
    const profile = this.profiles.find(
      (p) => p.id === def.profile.id && p.version === def.profile.version,
    );
    const ids = new Set(
      [...(profile?.required ?? []), ...(profile?.defaults ?? [])].map(
        (s) => s.id,
      ),
    );
    for (const s of [
      ...(def.capabilities ?? []),
      ...def.runtimeRequirements.guarantees,
    ]) {
      if (s.remove) ids.delete(s.id);
      else ids.add(s.id);
    }
    return [...ids].sort();
  }

  /**
   * Deterministic discovery: same query and same policy → same order (id asc, version desc).
   * Definitions the caller may not see are omitted without disclosure; a PDP outage fails closed.
   */
  async discover(
    query: DiscoveryQuery,
    caller: TrustedPrincipal,
    pdp: PolicyDecisionPoint,
  ): Promise<VersionedRef[]> {
    const text = query.text?.toLowerCase();
    const candidates = [...this.byKey.values()]
      .map((e) => e.definition)
      .filter((d) => (query.id ? d.id === query.id : true))
      .filter((d) => (query.profile ? d.profile.id === query.profile : true))
      .filter((d) =>
        query.capability
          ? this.declaredCapabilities(d).includes(query.capability)
          : true,
      )
      .filter((d) =>
        text
          ? `${d.displayName} ${d.description ?? ''}`
              .toLowerCase()
              .includes(text)
          : true,
      )
      .sort(
        (a, b) =>
          a.id.localeCompare(b.id) || semver.rcompare(a.version, b.version),
      );
    const visible: VersionedRef[] = [];
    for (const d of candidates) {
      try {
        await enforcePolicy(pdp, {
          principal: caller,
          action: 'definition:discover',
          resource: {
            type: 'agent-definition',
            id: d.id,
            tenantId: caller.tenantId,
          },
        });
        visible.push({ id: d.id, version: d.version });
      } catch (err) {
        if (isAgentropyError(err, 'PermissionDenied')) continue;
        throw err;
      }
    }
    return visible;
  }
}

export interface CreateInstanceRequest {
  definition: VersionedRef;
  ownerId: string;
  idempotencyKey: string;
}

/** Logical agent identities, owner- and tenant-scoped (Agent v1; runtime contract §3). */
export class InstanceDirectory {
  private readonly instances = new Map<string, AgentInstance>();
  private readonly byIdempotency = new Map<
    string,
    { instanceId: string; fingerprint: string }
  >();
  private seq = 0;

  constructor(
    private readonly definitions: DefinitionRegistry,
    private readonly newId: () => string = () => `inst-${++this.seq}`,
  ) {}

  create(req: CreateInstanceRequest, caller: TrustedPrincipal): AgentInstance {
    const key = `${caller.tenantId}|${caller.id}|${req.idempotencyKey}`;
    const fingerprint = digestOf({
      definition: req.definition,
      ownerId: req.ownerId,
    });
    const prior = this.byIdempotency.get(key);
    if (prior) {
      if (prior.fingerprint !== fingerprint)
        throw new AgentropyError(
          'IdempotencyConflict',
          'Idempotency key reused with a different request',
        );
      return structuredClone(this.instances.get(prior.instanceId)!);
    }
    this.definitions.require(req.definition);
    assertTransition(INSTANCE_MACHINE, null, 'available');
    const instance: AgentInstance = {
      id: this.newId(),
      definition: { ...req.definition },
      tenantId: caller.tenantId,
      ownerId: req.ownerId,
      state: 'available',
      revision: 1,
    };
    this.instances.set(instance.id, instance);
    this.byIdempotency.set(key, { instanceId: instance.id, fingerprint });
    return structuredClone(instance);
  }

  /** Tenant-scoped lookup: another tenant's instance is indistinguishable from a missing one. */
  get(instanceId: string, caller: TrustedPrincipal): AgentInstance {
    const inst = this.instances.get(instanceId);
    if (!inst || inst.tenantId !== caller.tenantId)
      throw new AgentropyError('NotFound', 'Instance not found', {
        details: { kind: 'instance' },
      });
    return structuredClone(inst);
  }

  /** Tenant of an instance, for distinguishing cross-tenant targets (AC-09) from missing ones. */
  tenantOf(instanceId: string): string | undefined {
    return this.instances.get(instanceId)?.tenantId;
  }

  list(caller: TrustedPrincipal, ownerId = caller.id): AgentInstance[] {
    return [...this.instances.values()]
      .filter((i) => i.tenantId === caller.tenantId && i.ownerId === ownerId)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((i) => structuredClone(i));
  }

  suspend(instanceId: string, caller: TrustedPrincipal): AgentInstance {
    return this.move(instanceId, caller, 'suspended');
  }

  resume(instanceId: string, caller: TrustedPrincipal): AgentInstance {
    return this.move(instanceId, caller, 'available');
  }

  /** Without force, retiring fails InvalidState while non-terminal tasks exist (checked by the caller-supplied guard). */
  retire(
    instanceId: string,
    caller: TrustedPrincipal,
    opts: { force?: boolean; hasActiveTasks?: () => boolean } = {},
  ): AgentInstance {
    if (!opts.force && opts.hasActiveTasks?.())
      throw new AgentropyError(
        'InvalidState',
        'Instance has non-terminal tasks',
        { details: { kind: 'instance' } },
      );
    return this.move(instanceId, caller, 'retired');
  }

  private move(
    instanceId: string,
    caller: TrustedPrincipal,
    to: AgentInstance['state'],
  ): AgentInstance {
    const inst = this.instances.get(instanceId);
    // Non-owners (other than trusted services) and other tenants get NotFound, never a state-revealing error (R-13).
    if (
      !inst ||
      inst.tenantId !== caller.tenantId ||
      (inst.ownerId !== caller.id && caller.type !== 'service')
    ) {
      throw new AgentropyError('NotFound', 'Instance not found', {
        details: { kind: 'instance' },
      });
    }
    assertTransition(INSTANCE_MACHINE, inst.state, to);
    inst.state = to;
    inst.revision += 1;
    return structuredClone(inst);
  }
}
