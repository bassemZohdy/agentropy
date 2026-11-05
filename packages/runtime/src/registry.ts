/** Definition registry, instance directory and discovery (M1-03, R-01, R-06, AC-15). In-memory for M1. */
import {
  AgentropyError,
  MemoryStore,
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
  type Store,
  type StoreTx,
  type StoredDocument,
  type TrustedPrincipal,
  type VersionedRef,
} from '@agentropy/core';
import semver from 'semver';
import { checkInstanceQuota, type QuotaResolver } from './quotas.js';

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

interface InstanceIdempotency {
  tenantId: string;
  instanceId: string;
  fingerprint: string;
}

/**
 * Logical agent identities, owner- and tenant-scoped (Agent v1; runtime contract §3). Every change is
 * committed to the Store before it is acknowledged, so instances survive a restart (R-08).
 */
export class InstanceDirectory {
  private seq = 0;

  constructor(
    private readonly definitions: DefinitionRegistry,
    private readonly store: Store = new MemoryStore(),
    private readonly newId: () => string = () =>
      `inst-${Date.now().toString(36)}-${++this.seq}`,
    private readonly quotas?: QuotaResolver,
  ) {}

  async create(
    req: CreateInstanceRequest,
    caller: TrustedPrincipal,
  ): Promise<AgentInstance> {
    const key = `instance:${caller.tenantId}|${caller.id}|${req.idempotencyKey}`;
    const fingerprint = digestOf({
      definition: req.definition,
      ownerId: req.ownerId,
    });
    this.definitions.require(req.definition);
    return this.store.transaction(async (tx) => {
      const prior = await tx.get<InstanceIdempotency>('idempotency', key);
      if (prior) {
        if (prior.value.fingerprint !== fingerprint)
          throw new AgentropyError(
            'IdempotencyConflict',
            'Idempotency key reused with a different request',
          );
        return (await tx.get<AgentInstance>(
          'instances',
          prior.value.instanceId,
        ))!.value;
      }
      await checkInstanceQuota(
        tx,
        caller.tenantId,
        this.quotas?.(caller.tenantId),
      );
      assertTransition(INSTANCE_MACHINE, null, 'available');
      const instance: AgentInstance = {
        id: this.newId(),
        definition: { ...req.definition },
        tenantId: caller.tenantId,
        ownerId: req.ownerId,
        state: 'available',
        revision: 1,
      };
      await tx.insert('instances', instance.id, instance);
      await tx.insert<InstanceIdempotency>('idempotency', key, {
        tenantId: caller.tenantId,
        instanceId: instance.id,
        fingerprint,
      });
      return instance;
    });
  }

  /** Tenant-scoped lookup: another tenant's instance is indistinguishable from a missing one. */
  async get(
    instanceId: string,
    caller: TrustedPrincipal,
  ): Promise<AgentInstance> {
    const doc = await this.store.transaction((tx) =>
      tx.get<AgentInstance>('instances', instanceId),
    );
    if (!doc || doc.value.tenantId !== caller.tenantId)
      throw new AgentropyError('NotFound', 'Instance not found', {
        details: { kind: 'instance' },
      });
    return doc.value;
  }

  /** Tenant of an instance, for distinguishing cross-tenant targets (AC-09) from missing ones. */
  async tenantOf(instanceId: string): Promise<string | undefined> {
    return (
      await this.store.transaction((tx) =>
        tx.get<AgentInstance>('instances', instanceId),
      )
    )?.value.tenantId;
  }

  /** Internal (trusted) read used by the runtime, e.g. to defer wake-ups of suspended instances. */
  async stateOf(
    instanceId: string,
  ): Promise<AgentInstance['state'] | undefined> {
    return (
      await this.store.transaction((tx) =>
        tx.get<AgentInstance>('instances', instanceId),
      )
    )?.value.state;
  }

  async list(
    caller: TrustedPrincipal,
    ownerId = caller.id,
  ): Promise<AgentInstance[]> {
    // Owners list their own instances; only trusted services may list another owner's (R-13).
    if (ownerId !== caller.id && caller.type !== 'service') return [];
    const docs = await this.store.transaction((tx) =>
      tx.find<AgentInstance>('instances', {
        where: { tenantId: caller.tenantId, ownerId },
      }),
    );
    return docs.map((d) => d.value).sort((a, b) => a.id.localeCompare(b.id));
  }

  suspend(
    instanceId: string,
    caller: TrustedPrincipal,
  ): Promise<AgentInstance> {
    return this.move(instanceId, caller, 'suspended');
  }

  resume(instanceId: string, caller: TrustedPrincipal): Promise<AgentInstance> {
    return this.move(instanceId, caller, 'available');
  }

  /** Without force, retiring fails InvalidState while non-terminal tasks exist (checked by the caller-supplied guard). */
  async retire(
    instanceId: string,
    caller: TrustedPrincipal,
    opts: {
      force?: boolean;
      hasActiveTasks?: () => boolean | Promise<boolean>;
    } = {},
  ): Promise<AgentInstance> {
    if (!opts.force && (await opts.hasActiveTasks?.()))
      throw new AgentropyError(
        'InvalidState',
        'Instance has non-terminal tasks',
        { details: { kind: 'instance' } },
      );
    return this.move(instanceId, caller, 'retired');
  }

  /**
   * Drain: stop accepting new tasks while existing tasks run to completion; the runtime retires the instance
   * when its last non-terminal task ends (TaskService.terminate). Retires at once when nothing is active.
   */
  async drain(
    instanceId: string,
    caller: TrustedPrincipal,
  ): Promise<AgentInstance> {
    return this.store.transaction(async (tx) => {
      const doc = await this.owned(tx, instanceId, caller);
      const inst = doc.value;
      if (inst.state === 'retired')
        throw new AgentropyError('InvalidState', 'Instance is retired', {
          details: { kind: 'instance' },
        });
      // Checked in the same transaction as the update, so no task can slip in between.
      const active = (
        await tx.find<{ status: string }>('tasks', { where: { instanceId } })
      ).some(
        (t) => !['completed', 'failed', 'cancelled'].includes(t.value.status),
      );
      if (!active) assertTransition(INSTANCE_MACHINE, inst.state, 'retired');
      const next: AgentInstance = {
        ...inst,
        draining: true,
        ...(active ? {} : { state: 'retired' as const }),
        revision: inst.revision + 1,
      };
      return (
        await tx.update<AgentInstance>(
          'instances',
          instanceId,
          doc.revision,
          next,
        )
      ).value;
    });
  }

  /** Owner-only: replace who may delegate to the instance (D-08). Shares never cross the tenant boundary. */
  async share(
    instanceId: string,
    principalIds: string[],
    caller: TrustedPrincipal,
  ): Promise<AgentInstance> {
    if (
      !Array.isArray(principalIds) ||
      principalIds.some((p) => typeof p !== 'string' || !p)
    )
      throw new AgentropyError(
        'SchemaViolation',
        'principalIds must be non-empty strings',
      );
    return this.store.transaction(async (tx) => {
      const doc = await this.owned(tx, instanceId, caller);
      if (doc.value.ownerId !== caller.id)
        throw new AgentropyError(
          'PermissionDenied',
          'Only the owner can share an instance',
        );
      const next: AgentInstance = {
        ...doc.value,
        sharedWith: [...new Set(principalIds)].filter(
          (p) => p !== doc.value.ownerId,
        ),
        revision: doc.value.revision + 1,
      };
      return (
        await tx.update<AgentInstance>(
          'instances',
          instanceId,
          doc.revision,
          next,
        )
      ).value;
    });
  }

  private async owned(
    tx: StoreTx,
    instanceId: string,
    caller: TrustedPrincipal,
  ): Promise<StoredDocument<AgentInstance>> {
    const doc = await tx.get<AgentInstance>('instances', instanceId);
    const inst = doc?.value;
    if (
      !doc ||
      !inst ||
      inst.tenantId !== caller.tenantId ||
      (inst.ownerId !== caller.id && caller.type !== 'service')
    )
      throw new AgentropyError('NotFound', 'Instance not found', {
        details: { kind: 'instance' },
      });
    return doc;
  }

  private move(
    instanceId: string,
    caller: TrustedPrincipal,
    to: AgentInstance['state'],
  ): Promise<AgentInstance> {
    return this.store.transaction(async (tx) => {
      const doc = await tx.get<AgentInstance>('instances', instanceId);
      const inst = doc?.value;
      // Non-owners (other than trusted services) and other tenants get NotFound, never a state-revealing error (R-13).
      if (
        !doc ||
        !inst ||
        inst.tenantId !== caller.tenantId ||
        (inst.ownerId !== caller.id && caller.type !== 'service')
      ) {
        throw new AgentropyError('NotFound', 'Instance not found', {
          details: { kind: 'instance' },
        });
      }
      assertTransition(INSTANCE_MACHINE, inst.state, to);
      return (
        await tx.update<AgentInstance>('instances', instanceId, doc.revision, {
          ...inst,
          state: to,
          revision: inst.revision + 1,
        })
      ).value;
    });
  }
}
