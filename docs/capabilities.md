# Composable capabilities and agent profiles

## Model

An Agent is defined by **identity + profile + capability bindings + policies**. A profile provides stable required/default/optional sets. The capability resolver calculates effective capabilities, rejects incompatible combinations and validates required provider guarantees.

Capabilities are **contracts**, not arbitrary boolean labels. Each contract specifies input/output semantics, configuration schema, version, dependencies, authorization and observable guarantees. A provider implements that contract; configuration binds providers to a definition or instance.

## Initial capability taxonomy

| Category | Capability | Contract / key concern |
|---|---|---|
| Interaction | Conversation | Multi-turn input/output, session ownership |
| Interaction | Notification | Progress/outcome communication and inbox policy |
| Coordination | Delegation | Create governed child tasks and report status |
| Coordination | Event handling | Subscription, acknowledgement and deduplication |
| Activation | Scheduling | Time-based wakeups with durable schedule records |
| Activation | Monitoring | Evaluate events, signals or conditions over time |
| Execution | Workflow | Invoke deterministic flows with explicit durability and failure semantics |
| Execution | Tool use | Execute approved APIs, MCP tools or adapters |
| Execution | AI reasoning/planning | Model choice bounded by budget/policy |
| State | Memory | Context and knowledge storage, retention controls |
| State | Durability | Persist, recover, resume, and reconcile execution state |
| Control | Human approval | Suspend for authorized user input |
| Control | Autonomy | Policy: permitted decisions, actions, limits, escalation |
| Reliability | Retry/idempotency | Bounded retries, deduplication, side-effect fencing |
| Observability | Audit/telemetry | Correlate decisions, delegations and outcomes |

**Important:** Durability is a guarantee requiring durable storage and tested providers; autonomy and permissions are **policies**, not interchangeable with execution capabilities. Telemetry and identity security are cross-cutting core runtime requirements even when advertised in capability descriptors.

## Profiles (proposed initial defaults)

| Profile | Required | Defaults | Optional |
|---|---|---|---|
| ConversationalAgent | conversation, identity context | message handling, session context | delegation, tools, memory, durability |
| TaskAgent | task execution, durable state | event activation, progress reporting | scheduled, workflow, reasoning, tools |
| MonitoringAgent | monitoring, event activation, durable state | status/notification | schedule, delegation, AI evaluation |
| CoordinatorAgent | delegation, task tracking | messaging, correlation | conversation, durable state, workflow |
| SpecialistAgent | defined task/tool contract | tool execution | reasoning, memory, conversation, durability |

TaskAgent scheduling is **not required** for one-off or event-driven tasks; it can be enabled by profile policy, instance config or task requirement. MonitoringAgent may combine event and scheduled polling. Any profile can gain conversation capability when authorized and supported.

## Resolution algorithm

1. Load immutable profile version and agent definition.
2. Apply profile defaults and explicitly requested capabilities.
3. Preserve required capabilities; allow default overrides where declared overridable.
4. Check dependency/compatibility constraints and contradictory policies.
5. Verify provider offers necessary semantics (durability, resumption, delivery).
6. Resolve effective permissions and tenant constraints; reject unapproved elevations.
7. Persist effective binding snapshot with version for reproducibility.

Do not silently coerce strong durability into in-memory execution or grant autonomy merely because an LLM provider is configured.

## Examples

A price-monitoring agent could combine `monitoring + events + scheduled + durable + notification + delegation`, while an expense-review task agent could combine `durable + workflow + human-approval + AI-reasoning`. Both use the same core Agent contract. A deterministic workflow controlled by a MonitoringAgent still counts as an agent-managed responsibility; it does not require an LLM invocation on each trigger.
