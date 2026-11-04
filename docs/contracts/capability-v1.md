# Agentropy Capability Contract v1.0 — Design baseline (revision 2)

**Status:** Architecture contract for initial implementation; no provider or runtime is implemented yet. **Errors:** [Errors v1](errors-v1.md).

## Revision history

| Rev | Date | Change |
|---|---|---|
| 1 | 2026-11-04 | Initial baseline |
| 3 | 2026-11-04 | Re-review: `reasoning`/`tool-use` usable in POC with fake providers; operation I/O for `delegate`, `notify`, `requestAction`, `subscribe`, `briefing`; durable event subscriptions |
| 2 | 2026-11-04 | Design review: canonical capability ID catalog; guarantees modelled once (as `kind: "guarantee"` selections with levels); operation `effect` classification and step keys; `task-execution` and `messaging` removed as capabilities; profile table reconciled with [capabilities](../capabilities.md) |
| 4 | 2026-11-04 | Align TaskAgent required `durable-execution` guarantee with accepted ADR-0019; no downgrade to `durable-acceptance` |
| 5 | 2026-11-04 | Document effective config hierarchy, non-weakening security floors and acceptance-time snapshots |

## Classification

- **Behavior capabilities** expose callable operations to handlers (delegation, tools, model, memory, …).
- **Guarantees** are runtime/provider obligations (durability). A declared guarantee must be verifiable by a conformance test.
- **Policies** constrain actions (autonomy level, allowed targets/tools, scope, budget, approval, limits). Policy is referenced by `policyRef`, never a provider plugin.
- **Platform obligations** (identity validation, audit, telemetry, the handler contract itself) always apply and are not capabilities.

## Canonical capability catalog (v1)

IDs below are the only valid capability IDs in v1. Other documents must use these spellings.

| ID | Kind | Purpose | Key operations (effect) | Phase |
|---|---|---|---|---|
| `conversation` | behavior | Multi-turn session I/O for user-facing agents | `reply` (internal), `briefing` (read) | POC |
| `session-context` | behavior | Session-scoped context store | `get` (read), `put` (internal) | POC |
| `delegation` | behavior | Create, query, cancel and wait on child tasks | `delegate` (external, step key), `getTask` (read), `cancel` (external) | POC |
| `notification` | behavior | Create user-facing inbox entries with priority | `notify` (external, step key) | POC |
| `event-handling` | behavior | Durable per-task subscriptions with an event mailbox ([runtime contract](../runtime-contract.md#event-subscriptions-no-lost-events-between-activations)) | `subscribe` / `unsubscribe` (internal, step key) | POC |
| `scheduling` | behavior | Timer and cron wake-ups | used via `WakeupRequest`; `nextOccurrence` (read) | POC |
| `human-input` | behavior | Create typed HumanActionRequests | `requestAction` (external, step key) | POC |
| `tool-use` | behavior | Invoke approved tools (incl. MCP) | `listTools` (read), `call` (external, step key) | POC (fake provider); real/MCP M2 |
| `reasoning` | behavior | Model calls bounded by budget/policy | `complete` (read*), `plan` (read*) | POC (fake provider); real M2 |
| `memory` | behavior | Durable agent knowledge with retention | `recall` (read), `remember` (internal) | M2 |
| `workflow` | behavior | Start/await a deterministic workflow on a provider | `start` (external, step key), `status` (read) | M2 |
| `durability` | guarantee | Survival semantics: `none` \| `durable-acceptance` \| `durable-execution` | — | POC |

\* Model calls are `read` for idempotency purposes (no external effect) but **are** metered against budget.

Removed or merged in rev 2:
- `task-execution` — every agent handles tasks; this is the handler contract, not a capability.
- `task-tracking` — merged into `delegation` (`getTask`, child-task wake-ups).
- `inbound-message`, `messaging` — inbound delivery is the platform's job (AgentService); outbound user messages use `notification`.
- `progress-reporting` — platform obligation via `context.progress`.
- `monitoring` — **open question (Q-03)**: a monitoring agent is currently expressible as `event-handling` + `scheduling` + `durability` + a handler that compares state across activations. Kept as a **profile**, not a capability, until a distinct operation set is identified.

## Contract types (normative conceptual shape)

```ts
export type CapabilityId = string;
export type CapabilityVersion = string;           // SemVer

export interface CapabilityContract {
  id: CapabilityId;
  version: CapabilityVersion;
  kind: "behavior" | "guarantee";
  configSchema: JsonSchema;
  dependencies: CapabilityRequirement[];
  conflicts?: CapabilityRequirement[];
  operations: OperationContract[];                // empty for guarantees
  levels?: string[];                              // guarantees only, ordered weakest -> strongest
}

export interface OperationContract {
  name: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  permission: string;                             // e.g. "delegation:delegate"
  effect: "read" | "internal" | "external";       // external => stepKey required
}

export interface CapabilityRequirement { id: CapabilityId; versionRange: string; }

export interface CapabilitySelection {
  id: CapabilityId;
  versionRange: string;
  config?: Record<string, unknown>;
  providerId?: string;
  level?: string;                                 // guarantees only, minimum level
  remove?: boolean;                               // definition-level removal of a profile default
}

export interface CapabilityBinding {
  id: CapabilityId;
  version: CapabilityVersion;                     // exact
  providerId: string;
  providerVersion: string;
  config: Record<string, unknown>;
  level?: string;                                 // guarantees: level actually provided
}

export interface AgentProfile {
  id: string;
  version: string;
  required: CapabilitySelection[];
  defaults: CapabilitySelection[];
  optional: CapabilityRequirement[];
}

/** Extra guarantees a definition needs beyond its profile; merged into the same selection set. */
export interface RuntimeRequirements { guarantees: CapabilitySelection[]; }

export interface EffectiveCapabilitySnapshot {
  snapshotId: string;
  bindings: CapabilityBinding[];
  policyRef: { id: string; version: string };
  resolvedAt: string;
}

export interface CapabilityProvider {
  readonly id: string;
  readonly version: string;
  readonly contracts: { id: CapabilityId; version: CapabilityVersion; level?: string }[];
  invoke<I, O>(operation: string, input: I, context: CapabilityInvocationContext): Promise<O>;
}

export interface CapabilityInvocationContext {
  tenantId: string;
  taskId: string;
  executionId: string;
  principalId: string;
  delegatedAuthorityRef?: string;
  idempotencyKey?: string;      // derived by the runtime from stepKey; present for external ops
  signal: AbortSignal;
}

export interface CapabilityAccess {
  invoke<I, O>(
    capabilityId: CapabilityId,
    operation: string,
    input: I,
    options?: { stepKey?: string }
  ): Promise<O>;
}
```

`supports()` from rev 1 is replaced by the static `contracts` declaration so resolution is data-driven and testable without calling the provider.

### Operation I/O for POC capabilities

| Operation | Input | Output |
|---|---|---|
| `delegation.delegate` | `DelegateInput` ([Agent v1](agent-v1.md)) | `TaskHandle` |
| `delegation.getTask` | `{ taskId }` (own children only) | `TaskSnapshot` |
| `delegation.cancel` | `{ taskId, reason? }` | `TaskSnapshot` |
| `notification.notify` | `{ severity: "critical" \| "high" \| "normal" \| "low"; title: string; body: string; dedupeKey?: string }` | `{ entryId }` — writes an outbox `notificationCreated` event in the same transaction ([messaging](../messaging-contract.md)) |
| `human-input.requestAction` | `{ kind, prompt, inputSchema, assignees, dueAt?, onExpiry }` | `{ requestId, dueAt? }` |
| `event-handling.subscribe` | `{ source: string; filter?: unknown }` | `{ subscription: string }` |
| `conversation.briefing` | `{ sessionId, limit? }` | `{ entries: InboxEntry[] }` (marks them `presented`) |
| `conversation.reply` | `{ sessionId, text }` | `{ messageId }` |
| `session-context.get` / `put` | `{ sessionId, key }` / `{ sessionId, key, value }` | `{ value? }` / `{}` |

**Provider execution:** `CapabilityAccess` is runtime-created per Execution and exposes only resolved, authorized bindings. Secrets are resolved at trusted boundaries and never appear in config snapshots.

## Guarantees

Durability is expressed exactly once: as a `kind: "guarantee"` selection with a minimum `level`, either in the profile or in `runtimeRequirements.guarantees`. The effective requirement is the strongest level requested. Resolution fails with `GuaranteeUnavailable` if the bound runtime offers a weaker level. Level semantics are defined in the [runtime contract](../runtime-contract.md#durability-levels).

## Profile defaults (v1)

| Profile | Required | Defaults | Optional examples |
|---|---|---|---|
| conversational | `conversation`, `session-context` | `delegation`, `durability: durable-acceptance` | `memory`, `tool-use`, `reasoning` |
| task | `durability: durable-execution` | `notification` | `scheduling`, `event-handling`, `workflow`, `reasoning`, `human-input`, `tool-use`, `delegation` |
| monitoring | `event-handling`, `durability: durable-execution` | `scheduling`, `notification` | `delegation`, `reasoning` |
| coordinator | `delegation`, `durability: durable-execution` | `notification` | `conversation`, `workflow`, `reasoning` |
| specialist | — | `tool-use` | `reasoning`, `memory`, `conversation`, `durability` |

Rationale: TaskAgent must preserve resumable execution state even without scheduling (accepted in ADR-0019). Coordinators and monitoring profiles also require `durable-execution` because they wait across activations; scheduling remains optional for task agents. A lightweight ephemeral helper uses a specialist/custom profile, not a downgraded task profile. `inbound-message`/`progress-reporting` are platform obligations.

## Effective configuration precedence and security floors (ADR-0019)

Effective ordinary configuration is resolved **framework → agent profile → agent definition → agent instance**; a nearer authorized setting can override a farther default. This applies to provider binding preferences and documented non-security timeout/retry/resource policies, but **does not weaken mandatory guarantees, required capabilities, tenant limits or higher-trust security floors**.

- A definition/instance cannot remove a profile `required` capability, reduce a `durability` minimum, increase an inherited authorization scope, bypass an approval or expand tenant access. Reject invalid configuration; do not silently downgrade.
- At **task acceptance**, pin immutable definition/profile/capability/provider/build versions and an effective, redacted configuration snapshot. Never copy credentials or bearer tokens into the snapshot.
- On **every protected operation**, re-evaluate current authorization, grant expiry/revocation and applicable non-weakening policy floors; snapshot pinning preserves deterministic execution settings, **not** perpetual permission.
- Runtime policy changes and version migration need explicit authorized handling and audit. Incompatible checkpoint/provider migration must fail explicitly rather than switching the accepted route or handler version.
- Exact config property schema, policy exception approval and dynamic update mechanisms remain implementation/conformance design, not implied by the simple precedence rule.

## Resolution algorithm (authoritative ordering)

1. Load exact immutable profile and definition versions; validate schemas.
2. Start with profile `required` + `defaults`; apply definition, then instance, additions and `remove` entries. Removing a `required` capability fails `InvalidConfiguration`; removing a default needs policy permission.
3. Expand dependencies transitively; detect cycles, conflicts, version incompatibility and contradictory duplicate selections.
4. Resolve ranges to exact contract versions and providers (explicit `providerId` wins; otherwise the deployment's configured default; ambiguity is an error, not a pick); validate config schemas.
5. Validate guarantee levels against the actual runtime/provider.
6. Intersect requested permissions with principal/tenant policy; reject escalation.
7. Persist an immutable `EffectiveCapabilitySnapshot` and reference it from the task at acceptance.
8. At each invocation: operation exists, binding present, authority still valid, `stepKey` present for `external` effects, guarantee still holds. Fail explicitly otherwise.

## Compatibility rules

- SemVer: incompatible operation/schema changes require a new major version.
- Ranges are authoring conveniences; accepted tasks pin exact versions.
- Replay compatibility of runtime adapters is tested independently of SemVer.
- Capability changes affect future tasks unless a documented migration updates an in-flight task.

## Required conformance checks

Required/default/optional merge; required-removal denial; dependency cycle and conflict; version resolution; ambiguous provider; missing provider; invalid config; permission reduction; unsupported operation; missing step key on external op; stale authority; guarantee level mismatch; pinning; tenant isolation; deterministic offline providers. A provider that cannot honor a required guarantee cannot be bound.
