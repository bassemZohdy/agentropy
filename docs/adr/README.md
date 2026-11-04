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

Use numbered Markdown files and record context, decision, consequences and open questions. Amend the ADR or supersede it with a new one when substantial direction changes.

## Design reuse

[Architecture reuse assessment from langgraph-flows](../reuse-from-langgraph-flows.md) maps source Flow-centered ADRs to Agentropy's separate agent, task and execution concepts. ADRs 0010–0014 are **proposals to validate**, not approvals or implemented features. Source ADRs do not implicitly become Agentropy decisions.
