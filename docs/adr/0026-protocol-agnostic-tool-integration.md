# ADR-0026: Protocol-agnostic tool integration abstraction

- Status: Accepted (architecture direction); concrete contracts and adapters pending
- Date: 2026-11-05
- Scope: Agentropy tools integration. Documentation decision only; no implementation or readiness-gate completion implied.

## Context

Agentropy already abstracts agent-to-agent communication behind a communication SPI and supports internal, A2A and custom implementations. Agent tools need an equivalent, independent boundary so agents do not depend on MCP, UTCP, HTTP/REST or a specific SDK. A tool and an agent capability are related but distinct: a capability describes what an agent is permitted/able to do; a tool describes a callable operation/resource exposed to fulfill that capability.

## Decision

1. **Parallel, domain-specific abstractions.** Agent communication and tool integration follow the same architectural principles (registry, pluggable providers, policies, observability, versioning, lifecycle), but **do not share a single generic transport interface**. Existing `CommunicationProvider` and agent/task semantics remain unchanged.
2. **Protocol-independent tool contract.** Introduce a canonical `ToolDescriptor` (stable logical identity/version, input/output schemas, provenance, effect/idempotency classification, required authority and declared guarantees); `ToolRegistry` for discovery and lifecycle; `ToolExecutor` for invocations; and a `ToolProvider` SPI with provider-specific binding/configuration and capability negotiation. Names are conceptual until contract review.
3. **Replaceable adapters.** MCP, UTCP, direct HTTP/REST/OpenAPI and custom/native implementations are adapters behind `ToolProvider`; none is a mandatory dependency of core Agent or Capability contracts. SDK and protocol versions are deferred.
4. **Tool identity independent of endpoint.** One logical tool MAY have multiple bindings, selected by explicit configuration/policy and negotiated guarantees. Provider switching must not silently alter semantics or trust/scope; logical identity, version, tenant and binding identity remain auditable.
5. **Security in the framework.** Discovery is not authorization. Verified registration, administrative activation/update and each protected invocation pass mandatory framework PEP/PDP controls per ADR-0021, with trustworthy agent/user/tenant identity, scoped delegation, policy version, current revocation and just-in-time credential resolution. A remote tool manifest/output is untrusted input, not a source of policy or new privileges. Adapters enforce transport-specific protections in addition to—not instead of—framework policy.
6. **Operational behavior.** Centralize schema validation, timeout/budget enforcement, redaction, structured errors, telemetry and mandatory audit intent; providers declare actual support for cancellation, streaming, authentication, retries, sandboxing, recovery and result guarantees. Unsupported requested guarantees fail explicitly. Do not retry non-idempotent or uncertain side effects without reconciliation; fallback is policy-approved and safe only when identities, scopes, data residency and effect semantics permit it.
7. **Isolation.** Tool and agent communication are separate boundaries. A tool adapter never impersonates an agent or bypasses task acceptance/delegation checks. Tenant, workspace and credential segregation remain applicable regardless of selected protocol.

## Illustrative architecture

```text
Agent Runtime
  |-- Agent Communication API --> CommunicationProvider SPI --> Internal | A2A | Custom
  `-- Tool API ---------------> ToolRegistry / ToolExecutor
                                   |-- Policy + credential + audit gates
                                   `-- ToolProvider SPI --> MCP | UTCP | REST/OpenAPI | Custom
```

## Acceptance and follow-ups

- Define a versioned canonical descriptor and invocation/result/error schema, explicit provider binding and provider capability negotiation.
- Conformance: same logical tool via at least two adapters with no agent code change; schema validation; provider-unavailable/unsupported semantics; cancellation/streaming negotiation; version and route selection.
- Negative security tests: discovery-only cannot execute; unapproved activation or upgrade denied; spoofed tenant/actor rejected; revoked scope/PDP outage fail closed; secrets redacted; audit records contain logical tool and physical binding.
- Failure tests: timeout, unknown remote outcome, duplicate requests, idempotency, safe/unsafe fallback and worker restart.
- Implement a minimal direct adapter before committing to any MCP/UTCP SDK. Compare protocol choices by use case, not as a winner-takes-all architecture decision.
- Track contract/design closure in TODO; implementation and M1 scope still require readiness review.

## Consequences

Adding new tool protocols requires a provider adapter rather than changing Agent contracts. The abstraction has nontrivial schema normalization, provider capability and security-boundary costs; guarantee parity must be proven, not assumed.

## Related

- [Communication v1](../contracts/communication-v1.md)
- [ADR-0019](0019-operational-and-communication-decisions.md)
- [ADR-0021](0021-delegated-authorization.md)
- [Requirements](../requirements.md)
- [Roadmap](../../TODO.md)

## Agent Skills standard alignment (accepted 2026-11-05)

Agentropy treats **Skills, Capabilities and Tools as separate concepts** within the same Agent extensibility architecture; this ADR records their boundaries without conflating their contracts:

- **Agent Skill** follows the established [Agent Skills open specification](https://agentskills.io/specification). A Skill is a portable directory with a required `SKILL.md` containing standard frontmatter and instructions; optional supporting scripts, references and assets follow that specification. Do not invent an incompatible Agentropy-specific Skill file format. Pin or record the specification version validated by compatibility tests.
- A **SkillRegistry** discovers, verifies and versions Skills; a **SkillLoader** makes metadata available for discovery and loads instructions/supporting files on demand (progressive disclosure). Registry identity/version and trust metadata are platform concerns and must not silently rewrite `SKILL.md`.
- **AgentDefinition** selects Skill references separately from Capability selections. Capability is a platform behavior or guarantee, while Tool is a callable external/internal operation. Skill instructions may describe workflows and reference executable scripts, but possession of a Skill grants **no** authority to invoke a Tool, execute a script, or expand capabilities.
- Required capabilities, tool dependencies and authorization are resolved against explicit platform metadata/policy, not inferred as trustworthy permissions from arbitrary Skill instructions. Installing, updating, loading or executing untrusted Skill content is governed by provenance validation, tenant isolation, explicit activation approval, sandbox limitations, scoped credentials and PEP/PDP checks per ADR-0021. Skill files are untrusted input.
- Keep Skill loading distinct from executing a Tool or a script. Scripts run only through approved execution interfaces with declared isolation and side-effect guarantees; unsupported sandbox guarantees fail explicitly.

**Acceptance follow-up:** standard Skill fixture imports without conversion, metadata-first discovery, lazy supporting-file loading, immutable pinned version per task, missing-resource/unsupported-feature errors, duplicate/version conflict rejection, and negative tests for malicious instructions and unauthorized script/tool invocation. SDK or concrete runtime selection remains deferred. These are design decisions; no implementation is claimed.
