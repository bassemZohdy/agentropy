# Architecture Decision Records

ADRs capture architectural direction separately from implementation status. **Accepted** means the current design direction was agreed during architecture discussions; it does not imply implemented or validated. **Proposed** identifies choices awaiting design/POC confirmation.

| ADR | Decision | Status |
|---|---|---|
| [0001](0001-capability-composition.md) | Capability composition over inheritance | Accepted |
| [0002](0002-agent-roles-profiles.md) | Roles and capability profiles | Accepted |
| [0003](0003-multi-agent-user-model.md) | Main assistant and delegated agents | Accepted |
| [0004](0004-logical-agent-lifecycle.md) | Separate definition, instance, task and execution | Accepted |
| [0005](0005-registry-directory-pool.md) | Registry, directory and pool boundaries | Accepted |
| [0006](0006-workflows-as-capabilities.md) | Workflows as agent execution capabilities | Accepted |
| [0007](0007-always-on-and-inbox.md) | Always-on reactivation and shared inbox | Accepted |
| [0008](0008-provider-neutral-runtime.md) | Pluggable runtime and durable guarantees | Proposed |
| [0009](0009-authorization-and-governance.md) | Scoped delegation and auditable policy | Proposed |
| [0010](0010-async-first-and-state-operations.md) | Async-first delegation and task state guards | Proposed |
| [0011](0011-versioned-agent-messaging.md) | Versioned command/query/event envelopes | Proposed |
| [0012](0012-human-actions-and-priority.md) | Actionable inbox, approval and priority policy | Proposed |
| [0013](0013-version-pinned-agent-executions.md) | Definition/provider version pinning | Proposed |
| [0014](0014-application-isolation-and-test-contracts.md) | Per-app isolation and offline provider contract tests | Proposed |
| [0015](0015-pluggable-agent-communication.md) | Communication abstraction; internal, A2A and custom providers | Accepted |
| [0016](0016-implementation-language.md) | TypeScript/Node.js, pnpm monorepo, JSON Schema, Vitest | Accepted (M1) |
| [0017](0017-first-persistence-and-activation.md) | SQLite store port, polling wake-up scheduler, in-process bus and outbox (M1) | Accepted (M1) |
| [0018](0018-execution-per-activation.md) | One execution per activation; standing duties as cycling tasks | Proposed |

**Review note (2026-11-04):** Earlier proposed ADRs were individually assessed without blanket acceptance. See the [ADR status reconciliation](../review/2026-11-04-adr-status-reconciliation.md). Architecture acceptance does not imply runnable conformance or implementation.

| [0019](0019-operational-and-communication-decisions.md) | Operational rules, communication and durability guarantees | Accepted |
| [0020](0020-opentelemetry-observability.md) | OpenTelemetry and cross-agent context propagation | Accepted (baseline) |
| [0021](0021-delegated-authorization.md) | Delegation, credentials, policy and security audit | Accepted (baseline) |
| [0022](0022-security-audit-governance.md) | Audit access, retention, legal hold and integrity | Accepted (baseline) |
| [0023](0023-license-and-contributions.md) | Apache-2.0 license and DCO policy | Accepted |
| [0024](0024-pre-dispatch-authorization-gate.md) | Durable pre-dispatch eligibility gate without new task states | Accepted (design) |
| [0025](0025-security-infrastructure-errors.md) | Explicit PDP-unavailable and audit-commit failure error outcomes | Proposed |

Use numbered Markdown files and record context, decision, consequences and open questions. Amend the ADR or supersede it with a new one when substantial direction changes.

## Design reuse

[Architecture reuse assessment from langgraph-flows](../reuse-from-langgraph-flows.md) maps source Flow-centered ADRs to Agentropy's separate agent, task and execution concepts. ADRs 0010–0014 are **proposals to validate**, not approvals or implemented features. Source ADRs do not implicitly become Agentropy decisions.
