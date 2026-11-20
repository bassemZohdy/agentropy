# Agentropy Tool Contract v1 — revision 8

**Status:** Accepted for M1 implementation (2026-11-05) of the protocol-neutral core and a direct adapter. MCP, UTCP and REST/OpenAPI adapters are later work; no adapter is claimed beyond the executable tests in `packages/*/test`.
**Decision:** [ADR-0026](../adr/0026-protocol-agnostic-tool-integration.md). **Security:** [Security v1](security-v1.md), [ADR-0021](../adr/0021-delegated-authorization.md). **Errors:** [Errors v1](errors-v1.md).

## Revision history

| Rev | Date | Change |
|---|---|---|
| 1 | 2026-11-05 | Canonical `ToolDescriptor`, tool lifecycle, `ToolRegistry`, `ToolExecutor`, `ToolProvider` SPI, resolution and invocation order |
| 2 | 2026-11-05 | Invocation step 8 enforced (FEAT-022.3, AC-07): an `external` tool that is not declared `at-least-once` fails `InvalidConfiguration` before audit or dispatch when its provider lacks `idempotencyKeys` |
| 3 | 2026-11-05 | D-04 (TASK-026.5): a binding may list `config.fallbackBindings`; only a `read` tool fails over to them, in order, after `ProviderUnavailable` or `Timeout`. Tools with effects never fail over (their failed outcome stays `UnknownAcceptance`) |
| 4 | 2026-11-14 | FIX-059 (review N-11): the MCP HTTP transport recovers from a lost session: a 404 for a request that carried `Mcp-Session-Id` means the server dropped the session, so the client forgets it, initializes a new session and repeats the request once (a second loss is `ProviderUnavailable`); the `initialize` request sends the runtime package version as `clientInfo.version` |
| 5 | 2026-11-14 | TASK-068 (review N-20): the MCP HTTP transport enforces `maxResponseBytes` (default 1 MiB) while it reads the reply, so an endless reply is cut off and its connection released instead of being buffered whole; the caller's abort signal covers the body |
| 6 | 2026-11-14 | FEAT-074 (review N-26): the status an operator sets (activate, suspend, revoke) is kept in the store when the registry is given one (`new InMemoryToolRegistry(security, verify, { store })`), one row per version in the `lifecycle` collection, so a revoke or suspend reaches every worker on the store at once and survives a restart: the executor (and skill loader) act on the stored status, not on the process's memory; `register` after a restart adopts it (a suspended or revoked version comes back as such) and returns the effective record, so a bootstrap activates only a `registered` version; `revoked` is final; a row names the content digest it was set for and never applies to different content; a stored `active` does not make unverified content usable; `ToolRegistry.refreshed(ref)` returns a record with that status |
| 7 | 2026-11-20 | FIX-085: the MCP HTTP transport no longer reads the reply to a notification (it expects `202` with no body): any body is cancelled, so a server that answers `notifications/initialized` with a large or endless body cannot make the client buffer it, which `maxResponseBytes` did not cover. An error reply (status 300 or above) also has its body cancelled before the error is raised, so the connection is released at once rather than at garbage collection |
| 8 | 2026-11-20 | FIX-084: task acceptance also acts on the stored status: resolution step 2 reads the versions with `InMemoryToolRegistry.refreshedVersions(id)`, so a version activated on another worker is accepted and one revoked or suspended there is refused (`CapabilityUnavailable`) instead of being pinned and failing at first call; `AcceptanceEnvironment.toolVersions` (and `skillVersions`) may answer with a promise. `reasoning.complete` reads an offered tool's stored status too and refuses a pinned tool that is no longer `active` with `PermissionDenied` (details `status`) before the model is asked. The synchronous `get` and `versions` stay this process's view |

## Concepts

| Concept | Meaning | Not |
|---|---|---|
| `tool-use` capability | The handler's only effect surface for tools ([Capability v1](capability-v1.md)) | A list of tools |
| Tool | Logical, versioned callable operation with schemas and effect class | An endpoint or URL |
| Tool binding | Physical route to a provider (direct, MCP, UTCP, REST, custom) for one tool version | A permission |
| `ToolSelection` | Definition-level request to make a tool visible ([Agent v1](agent-v1.md)) | An authorization grant |

## TypeScript contract (normative)

```ts
export type ToolId = string;                 // lowercase dotted logical id, e.g. "finance.payout"

export type ToolStatus = "registered" | "active" | "suspended" | "revoked";

export interface ToolProvenance {
  publisher: string;
  source: string;                            // where the descriptor came from (package, MCP server, file)
  digest: string;                            // digest of the canonical descriptor
  verified: boolean;                         // set by the registry's verifier, never by a manifest
}

export interface ToolDescriptor {
  id: ToolId;
  version: Version;                          // SemVer, immutable once registered
  description: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  effect: "read" | "internal" | "external";  // external ⇒ step key required at invocation
  idempotency: "idempotent" | "keyed" | "at-least-once"; // "keyed": honors the derived idempotency key
  permission: string;                        // PDP action, e.g. "tool:finance.payout:call"
}

export interface ToolBinding {
  bindingId: string;
  toolId: ToolId;
  toolVersion: Version;
  providerId: string;
  providerVersion: Version;
  config: Record<string, unknown>;           // non-secret; secrets only as opaque credentialRef
  credentialRef?: string;
  default?: boolean;                         // default binding when a selection names none
}

export interface ToolRecord {
  descriptor: ToolDescriptor;
  provenance: ToolProvenance;
  bindings: ToolBinding[];
  status: ToolStatus;
  revision: number;
}

/** Pinned per task in the AcceptanceSnapshot. */
export interface ToolPin {
  toolId: ToolId;
  toolVersion: Version;
  bindingId: string;
  providerId: string;
  providerVersion: Version;
  digest: string;
}

export interface ToolProviderFeatures {
  protocol: string;                          // "direct" | "mcp" | "utcp" | "rest" | custom
  protocolVersion: string;
  cancellation: boolean;
  idempotencyKeys: boolean;                  // passes idempotency keys to the remote side
  streaming: boolean;
}

export interface ToolInvocationContext {
  tenantId: string;
  taskId: string;
  executionId: string;
  principal: TrustedPrincipal;
  idempotencyKey?: string;                   // derived by the runtime from stepKey
  credential?: unknown;                      // just-in-time resolved; never persisted or logged
  deadline?: string;
  signal: AbortSignal;
}

export interface ToolProvider {
  readonly id: string;
  readonly version: Version;
  readonly features: ToolProviderFeatures;
  invoke(binding: ToolBinding, descriptor: ToolDescriptor, input: unknown, ctx: ToolInvocationContext): Promise<unknown>;
}

export interface ToolRegistry {
  register(descriptor: ToolDescriptor, bindings: ToolBinding[], provenance: Omit<ToolProvenance, "digest" | "verified">, admin: TrustedPrincipal): Promise<ToolRecord>;
  activate(ref: VersionedRef, admin: TrustedPrincipal): Promise<ToolRecord>;
  suspend(ref: VersionedRef, admin: TrustedPrincipal): Promise<ToolRecord>;
  revoke(ref: VersionedRef, admin: TrustedPrincipal): Promise<ToolRecord>;
  get(ref: VersionedRef): ToolRecord | undefined;
  /** Discovery is metadata only and never implies invocation permission. */
  discover(query: { text?: string }, caller: TrustedPrincipal): Promise<ToolDescriptor[]>;
}

export interface ToolExecutor {
  invoke(pin: ToolPin, input: unknown, ctx: ToolInvocationContext & { stepKey?: string }): Promise<unknown>;
}
```

## Lifecycle

`registered → active ⇄ suspended`, any state → `revoked` (terminal). Register, activate, suspend and revoke are **protected administrative operations**: each requires an Allow decision for `tool-admin:<operation>` and a durable audit intent ([Security v1](security-v1.md)). Re-registering an identical `id@version` (same descriptor digest) is a no-op; different content → `InvalidConfiguration`. A descriptor from an untrusted source is stored with `verified: false` and cannot be activated (`PermissionDenied`).

## Resolution at task acceptance

For each `ToolSelection` (`id`, `versionRange`, `required`, optional `bindingId`):

1. `tool-use` must be in the effective capability set when any tool is selected → otherwise `InvalidConfiguration`.
2. Choose the highest `active` version that satisfies the range, by the status kept in the store when the registry has one (revision 8), so an operator action on any worker counts; none → `CapabilityUnavailable` (details `{ kind: "tool", id }`).
3. Choose the binding: explicit `bindingId`, else the single `default` binding, else the only binding; zero or ambiguous → `CapabilityUnavailable` (`reason: "binding"`). The binding's provider must be registered.
4. Ask the PDP for `descriptor.permission` for the accepting principal (visibility check); deny → `PermissionDenied`; PDP failure → `PolicyDecisionUnavailable`.
5. A failing **optional** selection is omitted and recorded in `AcceptanceSnapshot.omitted` with its error code; a failing **required** selection rejects acceptance. `PolicyDecisionUnavailable` always rejects (fail closed).

## Invocation order (ToolExecutor)

1. Pin present in the task's snapshot (handler cannot name an unpinned tool) → else `CapabilityNotDeclared`.
2. Record still `active` → `suspended`/`revoked` → `PermissionDenied` (details `status`).
3. Tenant: `principal.tenantId` equals `ctx.tenantId` → else `TenantMismatch`.
4. Fresh PDP decision for `descriptor.permission` (never a cached acceptance-time Allow) → `PermissionDenied` / `PolicyDecisionUnavailable`.
5. `effect: "external"` requires a `stepKey` → else `SchemaViolation` (`reason: "missingStepKey"`).
6. Validate input against `inputSchema` → `SchemaViolation`.
7. Durable audit intent → `AuditCommitUnavailable` (no dispatch).
8. Provider invocation with the derived idempotency key; provider errors map to `ProviderUnavailable`, `Timeout`, `UnknownAcceptance` or `Internal`. A provider without `idempotencyKeys` for an `external` tool is treated as at-least-once and must be declared `idempotency: "at-least-once"`.
9. Validate output against `outputSchema` → `SchemaViolation`.

Tool manifests, outputs and errors are untrusted data: they are validated and never change policy, bindings or authority. Fallback to a different binding mid-task is not performed in v1.

## Conformance checks

Discovery-only tool cannot be invoked; unverified tool cannot be activated; unauthorized activation denied; suspended/revoked tool denied at invocation; PDP outage fails closed; spoofed tenant rejected; missing step key on an external tool; schema violation in/out; same logical tool through two bindings gives the same result without agent code change; audit intent failure prevents dispatch; secrets never present in pins, config snapshots or errors; with two workers on one store, a version activated on one is accepted by the other and one revoked on one is refused at the other's acceptance and not offered by its `reasoning.complete` (revision 8, `packages/testkit/test/lifecycle-acceptance.test.ts`).

## MCP adapter (FEAT-035.1)

`McpToolProvider` (provider `mcp`, `@agentropy/runtime`) runs tools of a Model Context Protocol server (revision 2025-06-18) behind the same registry, pinning, policy, audit and schema checks as any other provider.

- **Discovery is a candidate list.** `McpClient.listTools()` reads `tools/list`; `mcpToolRegistration(tool, { idPrefix, version })` turns each tool into a Tool v1 descriptor and binding. The tool must still be registered, verified and activated by an administrator; nothing is activated automatically.
- **Effects and idempotency.** A tool annotated `readOnlyHint` is `read`/`idempotent`; every other tool is `external` and `at-least-once` (MCP carries no idempotency key, so the provider declares `idempotencyKeys: false` and the executor refuses to bind it to a tool that claims `keyed` or `idempotent` effects unless the server's own `idempotentHint` says so). Cancellation is the abort signal passed to the transport.
- **Schema pinning.** The binding's `config.schemaDigest` is the digest of the tool's input and output schemas at registration. Before a call the provider compares it with the server's current `tools/list` (cached for `schemaTtlMs`, default 5 minutes, and re-read once before refusing); a changed or missing tool fails `IncompatibleVersion` and is not called.
- **Results are data.** A reply's `structuredContent` is the output; otherwise the text content is returned as `{ text }`. A tool-reported error (`isError`) or a JSON-RPC error is `ProviderUnavailable` carrying only the numeric code, never the server's text.
- **Transport.** `mcpHttpTransport({ url, fetch })` is the Streamable HTTP transport: one POST endpoint, JSON or SSE replies, the `Mcp-Session-Id` issued at `initialize` sent afterwards (a 404 for it starts a new session once, revision 4), a resolved credential `{ token }` as a Bearer header (`binding.credentialRef` as for any tool), redirects never followed, replies capped at 1 MiB while they are read; 401/403 is `AuthorityExpired`. stdio servers are not supported (a process supervisor is a deployment concern); implement `McpTransport` for them.

