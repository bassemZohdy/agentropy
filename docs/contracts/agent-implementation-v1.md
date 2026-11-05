# Agentropy Agent Implementation Contract v1 — revision 1

**Status:** Accepted for M1 implementation (2026-11-05). Executable conformance is tracked in [TODO](../../TODO.md); no claim is made beyond the tests that exist in `packages/*/test`.
**Decision context:** [Agent v1](agent-v1.md) revision 7, [ADR-0008](../adr/0008-provider-neutral-runtime.md), [ADR-0027](../adr/0027-m1-setup-choices.md). **Errors:** [Errors v1](errors-v1.md).

## Revision history

| Rev | Date | Change |
|---|---|---|
| 1 | 2026-11-05 | Finalize the `AgentImplementationProvider` SPI conceptually introduced in Agent v1 revision 6; reconcile it with `HandlerRegistry` |

## Purpose

An `AgentDefinition.implementation` names **how** an agent's logic runs (native TypeScript handler, LangGraph.js graph, workflow engine, remote proxy). The implementation provider is a pluggable adapter. It never owns task state: the TaskService/AgentRuntime applies every lifecycle transition, leases executions, persists checkpoints and enforces policy ([runtime contract](../runtime-contract.md)).

## TypeScript contract (normative)

```ts
export interface ImplementationFeatures {
  /** Can resume an activation from a committed checkpoint (required for durable-execution waits). */
  checkpointResume: boolean;
  /** Observes AbortSignal; if false the runtime relies on cancelGracePeriod fencing only. */
  cooperativeCancellation: boolean;
  /** Can emit progress through context.progress during an activation. */
  progressReporting: boolean;
  /** Isolation actually provided; verified by conformance, never inferred from the provider name. */
  isolation: "in-process" | "process" | "sandbox";
  /** True only for remote proxies whose remote task is authoritative (M2+, A2A). */
  remoteAuthority: boolean;
}

/** Exact, pinned result of resolving AgentDefinition.implementation at task acceptance. */
export interface ImplementationBinding {
  providerId: string;
  providerVersion: Version;          // exact
  artifact: VersionedRef;            // exact artifact revision
  artifactDigest?: string;           // content digest when the provider can compute one
  features: ImplementationFeatures;  // as declared by the provider at resolution time
}

export interface ImplementationResolveContext {
  tenantId: string;
  signal?: AbortSignal;
}

export interface AgentImplementationProvider {
  readonly id: string;               // e.g. "native-ts", "langgraph-js", "workflow", "remote-proxy"
  readonly version: Version;         // exact SemVer
  readonly features: ImplementationFeatures;
  /** Validate that the artifact exists, is trusted and compatible. Never loads inline executable content. */
  resolve(ref: AgentImplementationRef, ctx: ImplementationResolveContext): Promise<ImplementationBinding>;
  /** Create the execution adapter for one pinned binding. Throws IncompatibleVersion if the artifact is gone. */
  createAgent(binding: ImplementationBinding): Agent;
}

export interface ImplementationProviderRegistry {
  register(provider: AgentImplementationProvider): void;   // duplicate id@version with different features → InvalidConfiguration
  get(providerId: string, providerVersion: Version): AgentImplementationProvider; // NotFound
}
```

`Agent`, `AgentImplementationRef`, `VersionedRef` and `Version` are defined in [Agent v1](agent-v1.md).

## Native TypeScript provider and HandlerRegistry

The built-in `native-ts` provider is backed by the `HandlerRegistry` of Agent v1. Handlers are registered under an **artifact reference** (`VersionedRef`). By convention a native definition uses `implementation.artifact = { id: definition.id, version: definition.version }`, which preserves the AC-10 behavior: unregistering an artifact while a task pinned to it is waiting makes the next activation fail with `IncompatibleVersion` (T8).

## Resolution and negotiation rules

1. Look up the provider by exact `providerId` + `providerVersion`; absent → `NotFound` (details `{ kind: "implementation-provider" }`).
2. `provider.resolve(ref)`; an unknown artifact → `NotFound` (`kind: "implementation-artifact"`); an untrusted or unverifiable artifact → `PermissionDenied`; an incompatible artifact revision → `IncompatibleVersion`.
3. Feature negotiation against the effective profile guarantees:
   - effective durability `durable-execution` requires `checkpointResume: true`, otherwise `GuaranteeUnavailable`;
   - `remoteAuthority: true` is rejected in M1 with `UnsupportedOperation` (remote tasks go through `TaskService → CommunicationRouter`, [Communication v1](communication-v1.md)).
4. The resulting `ImplementationBinding` is pinned in the task's [`AcceptanceSnapshot`](agent-v1.md#acceptance-snapshot-revision-7). No provider or artifact is re-selected for an accepted task.

## Invariants

- An adapter returns `AgentDisposition` values only; it never writes task, execution, wake-up, inbox or outbox records.
- Adapter-specific errors are mapped to the [Errors v1](errors-v1.md) catalog at the adapter boundary; a thrown non-Agentropy error is treated as a retryable attempt failure (T6), as for native handlers.
- Two different implementation providers must pass the **same** logical lifecycle tests (A-02 acceptance).
- LangGraph.js, workflow engines and remote proxies are optional adapters, never core dependencies.

## Conformance checks

Unknown provider; unknown artifact; untrusted artifact; durable profile on a provider without `checkpointResume`; remote-authority provider rejected in M1; identical lifecycle results for two providers; unregistered artifact after acceptance fails `IncompatibleVersion`; binding pinned at acceptance.
