# Composable capabilities and agent profiles

**Authoritative:** [Capability Contract v1](contracts/capability-v1.md) owns the capability ID catalog, profile defaults, resolution order and errors. This page explains the model with examples and does not restate those tables (revision 1 kept a second, diverging profile table here).

## Model

An agent is **identity + profile + capability bindings + policies**. A profile supplies required/default/optional capability sets; the resolver computes the effective set, rejects incompatible combinations, validates guarantee levels against the real runtime and pins the result to each accepted task.

Capabilities are **contracts**, not boolean labels: each declares operations (with schemas, permissions and an `effect` class), configuration schema, version and dependencies. A provider implements a contract; configuration binds a provider to a definition or instance.

Four things are deliberately **not** capabilities:

- **Policies** — autonomy level, allowed targets/tools, budgets, approval rules, delegation depth/fan-out. Referenced via `policyRef`. Configuring an LLM provider never grants autonomy.
- **Platform obligations** — identity validation, audit, telemetry, progress reporting, inbound message delivery and the handler contract itself. Always on.
- **Durability as a flag** — it is a *guarantee* with levels (`none`, `durable-acceptance`, `durable-execution`) that the runtime must prove.
- **Monitoring** — currently a *profile* combining `event-handling`, `scheduling` and `durable-execution` (open question Q-03 in [the review](review/2026-11-04-design-review.md)).

## Choosing a profile

| You want… | Profile | Typical additions |
|---|---|---|
| The user's main assistant | `conversational` | `reasoning`, `memory`, `tool-use` |
| A one-off or event-driven job | `task` | `workflow`, `human-input`, `tool-use` |
| A standing watch that reports when something happens | `monitoring` | `delegation`, `reasoning` |
| An agent that splits work across others and waits for them | `coordinator` | `reasoning`, `workflow` |
| A narrow tool-backed expert | `specialist` | `reasoning`, `memory` |

Profiles are templates, not types: any profile can add `conversation` when authorized. The TaskAgent profile requires `durable-execution` independently of scheduling; it needs `scheduling` only if it actually waits on time. A non-durable helper belongs to a specialist/custom profile rather than a downgraded task.

## Examples

**Price watch (no LLM).** Profile `monitoring` + `notification`. Each activation reads the observed price from the wake-up event, compares it with the threshold kept in the checkpoint, and either yields again (`waiting` on the next event) or calls `notification.notify` with step key `"crossed:<threshold>"` and completes. Re-delivery of the same event cannot produce a second notification.

**Expense review (LLM + human).** Profile `task` + `reasoning` + `human-input` + `workflow`. The handler asks the model for a risk summary, creates a HumanActionRequest with step key `"approval"`, yields on `{ kind: "human-action" }`, and on resume starts the payout workflow with step key `"payout"` if approved.

Both use the same Agent contract; neither handler knows whether it runs in-process or behind a workflow engine.
