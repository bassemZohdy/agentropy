# 2026-11-05 — Tool protocol evaluation: direct, MCP, UTCP (T-04)

**Decision scope:** which tool transport Agentropy implements first, and what each adapter must guarantee. It does not change [Tool v1](../contracts/tool-v1.md); every protocol plugs in as a `ToolProvider` behind the same registry, pinning, policy, audit and idempotency rules. Protocol details below are stated at the level the contract depends on and should be re-checked against each specification's current version when an adapter is built.

## Criteria (from Tool v1 and Security v1)

1. **Idempotency:** can the transport carry the derived idempotency key so an external effect is applied once? Without it the binding must be declared `at-least-once` (enforced since FEAT-022.3).
2. **Identity and credentials:** does the call carry Agentropy's delegated principal and a credential resolved per invocation, rather than a long-lived server secret?
3. **Schema fidelity:** can the provider's input/output schemas be pinned by digest at activation, so a server-side change is detected (`IncompatibleVersion`)?
4. **Cancellation and timeouts:** can an in-flight call be aborted, and is the outcome of a timed-out effectful call reported as unknown?
5. **Operational fit:** process model (in-process, stdio child, HTTP), offline testability, failure surface.

## Assessment

| Criterion | Direct (in-process function / own RPC) | MCP server (tool calls over MCP) | UTCP-style manual (call the tool's native endpoint) |
|---|---|---|---|
| Idempotency key | Native: passed in `ToolInvocationContext` | Not part of the tool-call contract; needs an agreed argument or server convention, else `at-least-once` | Depends on the native API; many HTTP APIs accept an idempotency header |
| Identity / credentials | Native | Server-level auth; per-call delegated identity needs adapter conventions | Native API auth per call; credential resolved per invocation fits well |
| Schema pinning | Code-reviewed, versioned with the binding | Tool list and schemas discovered from the server: must be snapshotted and digested at activation | Manual describes schemas; digest the manual |
| Cancellation | AbortSignal | Protocol-level cancellation notifications | Native API dependent |
| Ops fit | Simplest; no extra process | Large ecosystem of existing servers; stdio or HTTP transports; extra process to supervise | No intermediary server; one adapter per call template |

## Decision

- **M1–M2: direct provider only** (implemented, with the loopback JSON-RPC provider proving the out-of-process shape). It satisfies every criterion and keeps the conformance suite offline.
- **First external adapter: MCP**, because of ecosystem reach. Rules for that adapter: discovered tools enter the registry as candidates and need the normal activation (with schema digest); MCP tools with effects default to `idempotency: at-least-once` unless the server documents a key convention the adapter maps; credentials are resolved per invocation and never baked into the server configuration; discovery changes after activation surface as `IncompatibleVersion`, never as silent upgrades.
- **UTCP-style adapter:** later, for APIs that already support idempotency keys natively; it reuses the same provider SPI.
- Adapters are delivered under FEAT-028 (M3 extensibility); this note closes the evaluation (T-04). The MCP adapter was built in FEAT-035.1 following these rules ([Tool v1, MCP adapter](../contracts/tool-v1.md#mcp-adapter-feat-0351)).
