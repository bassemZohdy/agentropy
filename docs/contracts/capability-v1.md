# Agentropy Capability Contract v1.0 — Design baseline

**Status:** Architecture contract finalized for initial implementation; no provider or runtime is implemented yet.

## Classification

- **Behavior capabilities** provide callable interfaces (conversation, monitoring, delegation, workflow, tools, scheduling, events, memory, human input, notification).
- **Execution guarantees** are runtime/provider obligations (durability, recovery, idempotency and delivery). A declared guarantee must be verifiable.
- **Policies** constrain actions (autonomy level, allowed targets/tools, scope, budget, approval and limits). Policy is not a provider plugin.
- **Cross-cutting platform obligations** (identity validation, audit and telemetry) always apply; they cannot be disabled by omitting a capability.

## Contract types (normative conceptual shape)

```ts
export type CapabilityId = string;
export type CapabilityVersion = string;

export interface CapabilityContract {
  id: CapabilityId;
  version: CapabilityVersion;
  kind: "behavior" | "guarantee";
  configSchema: Record<string, unknown>;
  dependencies: CapabilityRequirement[];
  conflicts?: CapabilityRequirement[];
  operations: OperationContract[];
  guarantees?: string[];
}

export interface CapabilityRequirement {
  id: CapabilityId;
  versionRange: string; // SemVer range; resolved to an exact version
}

export interface OperationContract {
  name: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  permission: string;
}

export interface CapabilitySelection {
  id: CapabilityId;
  versionRange: string;
  config?: Record<string, unknown>;
  providerId?: string;
}

export interface CapabilityBinding {
  id: CapabilityId;
  version: CapabilityVersion; // resolved exact version
  providerId: string;
  providerVersion: string;
  config: Record<string, unknown>;
}

export interface AgentProfile {
  id: string;
  version: string;
  required: CapabilitySelection[];
  defaults: CapabilitySelection[];
  optional: CapabilityRequirement[];
}

export interface RuntimeRequirements {
  guarantees: CapabilityRequirement[];
}

export interface CapabilityProvider {
  readonly id: string;
  readonly version: string;
  supports(contract: CapabilityRequirement): boolean;
  invoke<I, O>(
    operation: string,
    input: I,
    context: CapabilityInvocationContext
  ): Promise<O>;
}

export interface CapabilityInvocationContext {
  tenantId: string;
  taskId: string;
  executionId: string;
  principalId: string;
  delegatedAuthorityRef?: string;
  idempotencyKey: string;
  signal: AbortSignal;
}

export interface CapabilityAccess {
  invoke<I, O>(capabilityId: string, operation: string, input: I): Promise<O>;
}
```

**Provider execution:** CapabilityAccess is runtime-created and exposes **only resolved, authorized bindings**. No generic unrestricted provider access. Provider selection and secret resolution occur at trusted boundaries. Provider implementations must validate operation contracts, not only return `supports=true`.

## Profile defaults (initial v1)

| Profile | Required | Defaults | Optional examples |
|---|---|---|---|
| conversational | conversation | session-context, inbound-message | delegation, memory, tool-use, durability |
| task | task-execution, durability | progress-reporting, event-handling | scheduling, workflow, reasoning, human-input |
| monitoring | monitoring, event-handling, durability | notification | scheduling, delegation, reasoning |
| coordinator | delegation, task-tracking | messaging | conversation, workflow, durability |
| specialist | task-execution | tool-use | reasoning, memory, conversation, durability |

**Clarification:** Scheduling is optional for TaskAgent; it can be configured as a default in a custom Task profile. `task-execution` and `task-tracking` are behavior contracts, not special inheritance. A profile may require an abstract capability that multiple providers can implement.

## Resolution algorithm (authoritative ordering)

1. Load exact immutable profile and definition versions; validate schemas.
2. Add profile **required** and **defaults**; apply definition/instance explicit additions/removals. Required capabilities cannot be removed; defaults can be removed only when allowed by policy.
3. Expand dependencies transitively, detect cycles, conflicts, version incompatibility and duplicate contradictory selections.
4. Resolve version ranges to exact contract versions and providers; validate config schema and provider compatibility.
5. Validate runtime guarantees against actual provider capabilities and deployment (durable storage, restart recovery, wake-up persistence).
6. Intersect requested permissions with effective principal/tenant policies; reject any escalation. Policy and identity checks are never replaced by capability flags.
7. Persist an immutable **EffectiveCapabilitySnapshot** with exact contract/provider versions, config and policy reference at task acceptance.
8. At invocation, check that the operation exists, the binding is enabled, the current authority permits it, and required guarantees still hold. Fail explicitly otherwise.

## Errors

Use typed errors such as `CapabilityUnavailable`, `CapabilityNotDeclared`, `UnsupportedOperation`, `IncompatibleVersion`, `InvalidConfiguration`, `PermissionDenied`, `GuaranteeUnavailable`, `ProviderUnavailable`. These represent distinct cases and must not be collapsed into silent no-ops. ProviderUnavailable may be transient; PermissionDenied is not automatically retryable.

## Compatibility rules

- Contract versions use SemVer as a policy convention; incompatible operation/schema changes require a new major version.
- Version ranges are authoring conveniences only; accepted tasks pin **exact** resolved versions.
- Runtime adapter compatibility (e.g., workflow history replay) is independently tested. SemVer matching does not imply replay compatibility.
- Dynamic capability enablement affects future tasks unless a documented, validated migration updates an in-flight task.

## Required conformance checks

Test required/default/optional merge, required removal denial, dependency cycle/conflict, version resolution, missing provider, invalid config, permission reduction, unsupported operation, stale authority, restart guarantee, pinning, tenant isolation and deterministic offline providers. A provider that cannot honor required guarantees cannot be bound.
