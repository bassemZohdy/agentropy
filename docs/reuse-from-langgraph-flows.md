# Architectural reuse assessment: langgraph-flows → Agentropy

**Reviewed:** 2026-11-04. **Source:** [bassemZohdy/langgraph-flows](https://github.com/bassemZohdy/langgraph-flows), main (tree `99317188dee2f9dcf87df1356bdf4fb1bd34345b`).  
**Scope:** Requirements, architecture patterns and design documentation only. **No code, files, dependency choices or implementation commitments are imported.** Source functionality is evidence that patterns can be explored, not proof that Agentropy supports them.

## Executive decision

Reuse the strongest engine-neutral, durable-execution, messaging, human-task, user-inbox, authorization and versioning concepts, **translated to Agentropy's multi-agent domain**. Preserve the distinction between the two repositories: a **Flow** is the top-level executable unit in langgraph-flows, whereas an **Agent** (definition/instance) owns a responsibility in Agentropy and **DelegatedTask/Execution** represent the corresponding work. Deterministic Flows/Workflows may be invoked inside Agentropy capabilities.

## Conceptual mapping (do not copy naming literally)

| langgraph-flows | Agentropy equivalent | Adaptation |
|---|---|---|
| FlowDefinition / FlowSpec | AgentDefinition + capability bindings; optionally WorkflowDefinition under a workflow provider | An agent's identity, role and authority are distinct from its executable flow |
| FlowRegistry | AgentDefinition Registry and Instance Directory | Keep definition registry separate from logical agent instances |
| FlowRun | DelegatedTask + Execution | Task owns objective; attempts and provider-specific run references belong to execution |
| FlowRuntime / FlowService | AgentRuntime + Delegation/Task Service | Agent runtime governs lifecycle; provider controls its own internal workflow |
| Flow capability flags | Versioned CapabilityContract + binding + AgentProfile | Capability interface plus enforced guarantees, dependencies and policies |
| Flow command/query/event | Agent/Task message envelopes | Include definition, instance, task, execution, parent/causation and identity |
| User Inbox | Shared user-scoped, actionable inbox projection | A user may receive results from multiple agents and delegated tasks |
| Human InputRequest | HumanActionRequest with stable request ID, assignee and authorization | Actions may belong to any authorized agent task |
| LangGraph conversation | Optional ConversationalAgent provider | Do not mandate LangGraph or Python |
| TemporalFlow | Optional workflow/durable provider | Do not mandate Temporal or equate "durable" with "uses Temporal" |
| Browser UI / CLI | Optional future presentation and developer experience | Core Agentropy is headless and provider-neutral initially |

## Reuse decisions by source evidence

| Source file / ADR | Reusable pattern | Agentropy action |
|---|---|---|
| [ADR-0002](https://github.com/bassemZohdy/langgraph-flows/blob/main/docs/adr/ADR-0002-flow-lifecycle-and-capability-operations.md), `flows/core/lifecycle.py` | Single explicit lifecycle/transition table; optional guarded operations; typed refusals | Specify Agent Task lifecycle and operation guards; preserve per-provider internal states |
| [ADR-0003](https://github.com/bassemZohdy/langgraph-flows/blob/main/docs/adr/ADR-0003-async-first-flow-execution-and-isolation.md) | Async-first accepted-start handle, bounded await helper, session independence | Make async delegation the baseline; distinguish acceptance from completion |
| [ADR-0004](https://github.com/bassemZohdy/langgraph-flows/blob/main/docs/adr/ADR-0004-pluggable-flow-communication.md), `flows/core/messages.py` | Versioned command/query/event envelopes, transport-independent API, correlation/causation | Agent-to-agent message contract, idempotency, authorization and transport adapters |
| [ADR-0005](https://github.com/bassemZohdy/langgraph-flows/blob/main/docs/adr/ADR-0005-user-inbox-actionable-projection.md), `flows/briefing.py` | Inbox as user-centered projection; turn-start briefing; presentation dedup | Shared inbox policy, state reconciler, separate read/presented/resolved markers |
| [ADR-0006](https://github.com/bassemZohdy/langgraph-flows/blob/main/docs/adr/ADR-0006-shared-priority-and-proactive-policy.md), `flows/priority.py` | Business + personal/context + policy priority floors, justified overrides | Priority resolver with hard policy minimum and presentation strategy |
| [ADR-0007](https://github.com/bassemZohdy/langgraph-flows/blob/main/docs/adr/ADR-0007-human-task-validation-and-idempotency.md), `flows/core/types.py` | Stable typed action requests, atomic validation, safe duplicate/conflicting decisions | Human approval/action contract, expiry, assignment and double-submit tests |
| [ADR-0008](https://github.com/bassemZohdy/langgraph-flows/blob/main/docs/adr/ADR-0008-delegated-identity-and-authorization.md), `flows/core/policy.py` | Pre-start delegated authorization; recheck sensitive acts; audit causality | Tighten Agent-to-Agent delegated scope and revocation/credential handling |
| [ADR-0009](https://github.com/bassemZohdy/langgraph-flows/blob/main/docs/adr/ADR-0009-version-pinned-flow-runs.md) | Pinned definitions and safe rollout across in-flight runs | Agent definition/profile/capability/provider-version snapshots and compatibility matrix |
| `flows/core/outbox.py`, [DEPLOY.md](https://github.com/bassemZohdy/langgraph-flows/blob/main/docs/DEPLOY.md) | Leased outbox delivery, restart recovery, event reconciliation, topology limits | Durable messaging design and test matrix; avoid assuming SQLite shared volume supports cross-host HA |
| [ADR-0011](https://github.com/bassemZohdy/langgraph-flows/blob/main/docs/adr/ADR-0011-per-app-factory-and-config.md) | Per-app context isolation, no mutable import-time globals, config precedence | Document an isolated application context and externalized non-secret configuration |
| [ADR-0018](https://github.com/bassemZohdy/langgraph-flows/blob/main/docs/adr/ADR-0018-author-test-contract-and-ci.md) | Provider contract testing with fake durable runtime and no paid LLM | Reusable capability/adapter conformance suite and offline examples |
| [ADR-0015](https://github.com/bassemZohdy/langgraph-flows/blob/main/docs/adr/ADR-0015-generated-ui-voice-and-web-shell.md) | Constrained structured UI and voice, SSE updates | Optional future UI adapters only; avoid coupling Agentropy core to a web shell |

## Patterns deliberately not imported

1. **Flow-first product vocabulary or mandatory Flow service.** Agentropy models agent definitions, instances, delegations and tasks first; workflow is a capability provider. A Flow-only lifecycle cannot replace the agent/task split.
2. **Concrete Python/FastAPI, LangGraph or Temporal choices.** These are implementation examples in langgraph-flows, not decisions for Agentropy.
3. **Four Flow class inheritance levels** (`InlineFlow`, `SkilledFlow`, `TemporalFlow`, `TemporalSkilledFlow`). Agentropy uses composition via capability profiles and bindings.
4. **Fixed UI shell, voice stack, page generator, theme, branding or CLI.** Keep presentation optional, headless core first.
5. **Flow-to-Flow orchestration exclusion.** That project intentionally avoids Flow-to-Flow DAGs; Agentropy explicitly supports bounded Agent-to-Agent delegation and child tasks.
6. **Local SQLite-as-shared-distributed-HA topology.** A per-host SQLite/WAL configuration does not create cross-host HA; retain only a development/local option if later selected.
7. **Implementation status claims.** Reusing an existing source design does not make it delivered in Agentropy.

## Changes proposed for Agentropy

- **Contract:** Async-first delegation, explicit lifecycle operations and versioned command/query/event envelopes.
- **Runtime:** Authoritative task state, optional capability guards, pinned versions, retry as a new attempt and recovery/lease fencing.
- **User experience:** User-centric actionable inbox, priority reconciliation, controlled proactive briefings and presentation deduplication.
- **Governance:** Formal human-action assignment/expiry/idempotency, least-privilege delegated identity and authorization at sensitive boundaries.
- **Engineering:** Runtime-independent conformance tests, offline fake providers, externalized configuration, measured recovery/deployment compatibility.

See [requirements](requirements.md), [architecture](architecture.md), [collaboration](collaboration.md), [operations](operations.md) and [new ADRs](adr/README.md) for the Agentropy-specific normative/proposed contracts.

## Documentation provenance

This is a **design adaptation**, not a literal source import or code migration. Source links are provided so future decisions can be compared against the implementation and source ADRs. Changes to langgraph-flows after the reviewed tree are not automatically inherited.
