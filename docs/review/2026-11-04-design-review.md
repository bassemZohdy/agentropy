# Design review — 2026-11-04 (pre-implementation)

**Scope:** every document in the repository at commit `930bf1e` (README, TODO, CHANGELOG, vision, requirements, architecture, domain model, capabilities, registry/runtime, collaboration, operations, runtime/messaging/human-action contracts, Agent/Capability/Communication v1, reuse assessment, ADR-0001…0015).
**Goal:** make the baseline consistent and specific enough to start M1 without re-deciding fundamentals mid-implementation.
**Outcome:** 20 findings; 18 resolved in documentation on this branch, 2 need a maintainer decision. Implementation has **not** started.

## What is already strong

- The four-identity split (definition / instance / task / execution) and "always-on = persisted responsibility" are the right core abstractions and are applied consistently in prose.
- Honest status language throughout: nothing claims to be implemented or production-ready.
- Explicit non-goals (no workflow engine, no mandatory LLM, no mandatory transport) and fail-explicitly rules for unsupported capabilities and guarantees.
- The langgraph-flows reuse assessment cleanly separates borrowed patterns from borrowed vocabulary.

## Findings

Severity: **High** = would block or derail implementation; **Medium** = would cause rework or inconsistent code; **Low** = hygiene.

| # | Sev | Finding | Resolution |
|---|---|---|---|
| F-01 | High | Task and execution lifecycles were described three different ways (domain model, runtime contract, Agent v1). Executions "checkpointed/waiting → resumed" contradicted Agent v1's lease release on `waiting` and `trigger: "resume"`. No transition table existed, although R-21 requires one. | [Runtime contract rev 2](../runtime-contract.md): explicit edge tables (T1–T11, E1–E8, instance, human action), guard ordering, single source of truth. [ADR-0018](../adr/0018-execution-per-activation.md) (proposed): one execution per activation |
| F-02 | High | Retry semantics contradicted each other: runtime contract ("new attempt or new task as specified"), messaging contract ("new execution, or new task if…"), Agent v1 ("new linked task"). | All three now say: recovery = new Execution in the same non-terminal task; explicit retry of a terminal task = new task with `retryOf` |
| F-03 | High | No replay-safe side-effect mechanism for handlers. `CapabilityInvocationContext` carried one `idempotencyKey` per invocation context, so a handler making several external calls had either colliding keys or none; a re-run after crash would repeat effects (e.g. duplicate notifications, duplicate child tasks). | Operations classified `read`/`internal`/`external`; external ops require a deterministic `stepKey`; runtime derives the key and keeps an effect journal ([Agent v1](../contracts/agent-v1.md#idempotent-side-effects)). New R-34, AC-07 |
| F-04 | High | Three overlapping ways to delegate (`AgentService.delegate`, `AgentCommunication.delegate`, `CapabilityAccess.invoke("delegation")`) with no stated layering. `AgentCommunication` operations had no caller principal, although routing rule 2 requires authenticating the caller first; `delegate(target, request)` duplicated `request.target`. | Call layering diagram in Agent v1: handler → capability → TaskService → (runtime \| router). AgentCommunication is an **outbound SPI of the TaskService**; every operation takes a `CallContext`; routes and remote task refs are explicit types ([Communication v1 rev 2](../contracts/communication-v1.md)) |
| F-05 | High | The wait model could not express core scenarios: no wake-up on child-task completion (a coordinator could not wait for its children), no one-shot timer vs recurring schedule, no timeout, no waiting on several conditions. | `WakeupRequest { anyOf, timeoutAt, onTimeout }` with `timer`, `schedule`, `event`, `human-action`, `child-tasks(all\|any)`; `wakeReason` and `checkpoint` delivered on resume |
| F-06 | High | Language, persistence, scheduler and event transport undecided (M0-01, M0-06) while all contracts are already TypeScript. | [ADR-0016](../adr/0016-implementation-language.md) and [ADR-0017](../adr/0017-first-persistence-and-activation.md) proposed. **Needs maintainer decision (Q-01)** |
| F-07 | High | No defined first deliverable (M0-07 open). Milestone 1 listed nine broad components with no journey or exit criteria, inviting component-by-component build-out. | [POC scope](../poc-scope.md): walking skeleton with two journeys, 14 acceptance checks, explicit out-of-scope list, package layout |
| F-08 | Medium | Capability IDs differed between `capabilities.md` and Capability v1 (`durable state` vs `durability`, `event activation` vs `event-handling`, …); IDs used in profiles (`task-execution`, `task-tracking`, `inbound-message`, `messaging`, `progress-reporting`) were not in the taxonomy; durability was modelled twice (profile capability **and** `RuntimeRequirements.guarantees`). | Canonical catalog with phase per capability in [Capability v1 rev 2](../contracts/capability-v1.md); non-capabilities removed with reasons; durability = one guarantee with levels `none` / `durable-acceptance` / `durable-execution`; capabilities.md no longer restates tables |
| F-09 | Medium | Error names were spread over three documents with a naming clash (`Unauthorized` vs `PermissionDenied`) and no retryability rule. | [Errors v1](../contracts/errors-v1.md): one catalog, categories, `retryable` semantics, no-state-leak rule |
| F-10 | Medium | Requirements: the R-31…R-33 table had no header row and did not render; R-04/R-21, R-05/R-22, R-09/R-27, R-12/R-25 overlapped silently; priorities conflicted (R-33 remote ownership P0 vs R-32 A2A P1 vs R-18 federation P2); acceptance "intents" were not testable; no traceability. | [Requirements rev 2](../requirements.md): one table, testable criteria, trace + milestone columns, overlap map, R-33 → P1, R-18 narrowed to registry federation |
| F-11 | Medium | Missing requirements for things the design depends on: replay-safe effects, model budget accounting, the conversational surface itself (delegation as a tool, turn-start briefing), standing duties, retention/redaction. | Added R-34…R-38 |
| F-12 | Medium | Instance lifecycle used `registered`, absent from the `AgentInstance.state` type. Task pause/resume appeared in UX docs and the command catalog but no provider semantics exist. | `registered` removed (definitions are registered, instances are created). Task pause/resume is `UnsupportedOperation` in v1; instance suspend/resume covers the need |
| F-13 | Medium | Domain model kept a stale TypeScript sketch (second `AgentProfile`, `AgentContext`, `Agent.execute`) and lacked entities the design relies on: checkpoint, wake-up registration, effect journal, outbox record, capability snapshot. | [Domain model rev 2](../domain-model.md): entity map + ER diagram + glossary, no duplicate types |
| F-14 | Medium | `HumanActionRequest`/decision had fields in prose but no type; inbox delivery markers were listed three different ways. | Types added to [human actions](../human-actions.md); five markers defined once |
| F-15 | Medium | Message envelope required `agentDefinitionId/Version` even for queries such as `listInbox`; no event payload shape or revision ordering rule. | Agent fields optional; `TaskEvent` with revision added to the [messaging contract](../messaging-contract.md) |
| F-16 | Low | TODO: "0 / 51" tasks while 48 are listed and M0-04 is checked; X-/C- backlogs float outside milestones. | [TODO.md](../../TODO.md) restructured, counts fixed, every item assigned to a milestone |
| F-17 | Low | CHANGELOG said "nine ADRs (seven accepted, two proposed)"; there are fifteen. | Corrected; review entry added |
| F-18 | Low | ADR-0015 is Accepted while ADR-0008/0009, which it relies on, are Proposed. | Flagged in the [ADR index](../adr/README.md); to be settled together in X-01 (Q-04) |
| F-19 | Low | `Agent.definition` held a full `AgentDefinition`, coupling handler code to registry data. | Now a `VersionedRef`; the registry owns the definition |
| F-20 | Low | `registry-runtime.md` sketched `AgentRuntime.suspend/resume(executionId)`, contradicting the execution model. | Replaced with `activate`, `requestCancel`, `fireWakeup`; pool leases carry epochs |

## Open questions for the maintainer

| # | Question | Recommendation |
|---|---|---|
| Q-01 | Implementation language and tooling (ADR-0016) | TypeScript/Node LTS, pnpm, Vitest — matches every existing contract |
| Q-02 | License and contribution policy (M0-02) | Apache-2.0 (patent grant, common for agent frameworks) + DCO sign-off |
| Q-03 | Is `monitoring` a capability with its own operations, or only a profile? | Keep as profile in M1; revisit with M2 evidence |
| Q-04 | Accept ADR-0008…0014 and 0016…0018 as a set? | Yes, after reading the rev-2 contracts; amend in place if anything here is rejected |
| Q-05 | Threat model timing (M0-05) | Lightweight trust-boundary note before M1 covering AC-09; full threat model in M2 before A2A |
| Q-06 | Default checkpoint size limit and codec | JSON, 256 KiB default, configurable; enforced by the runtime |

## Not changed (deliberately)

Vision, non-goals, operations, collaboration and the reuse assessment were left substantively as they are: they are consistent with the revised contracts at the level of detail they target.

## Re-review after merge

An independent reviewer (no access to the first pass) read every document after PR #1 merged and reported 25 findings. All were verified against the text and fixed on the follow-up branch. Several were defects introduced by the first pass itself (R-01, R-06, R-09).

| # | Sev | Finding | Fix |
|---|---|---|---|
| R-01 | High | Effect journal committed with the disposition transaction, so AC-07's crash lost it | Journal committed at invocation time; internal effects exactly-once with their journal ([Agent v1](../contracts/agent-v1.md#idempotent-side-effects), ADR-0017) |
| R-02 | High | J2 used `reasoning`/`tool-use`, which were M2-only | Both POC-phase with fake providers |
| R-03 | High | J1 used a fake model, contradicting R-17 "no model provider" | J1 conversational agent is rule-based |
| R-04 | High | Events arriving while a task was running matched no armed registration and were lost | Durable subscriptions with per-task mailbox ([runtime contract](../runtime-contract.md#event-subscriptions-no-lost-events-between-activations)) |
| R-05 | High | Two overlapping expiry mechanisms (`onExpiry` vs `onTimeout`); `requestAction` output undefined | One mechanism: request `dueAt` + `onExpiry`; `requestAction` returns `requestId` |
| R-06 | High | `provideHumanInput` task-state guard made duplicate/conflict outcomes in AC-08 impossible | Decision checked against the request first |
| R-07 | High | No event path from `notify` to the inbox; `notify` input undefined | `notificationCreated` event + operation I/O table |
| R-08 | High | No entry point for a user turn; `CapabilityAccess` only inside executions | Turn model: `submitTurn` creates a turn task; briefing at start |
| R-09 | High | Attempt budget/backoff/retry policy undefined | `retryPolicy` on definitions; thrown errors retryable |
| R-10 | Med | No `register`, no handler binding for AC-10/R-01 | `AgentRegistry.register`, `HandlerRegistry` |
| R-11 | Med | Cancel grace → `lost` not an execution edge; grace period undefined | E8 trigger + `cancelGracePeriod` |
| R-12 | Med | Queued execution had no terminal edge when task failed/cancelled | E7 for queued/leased without handler; E7b for running |
| R-13 | Med | Revision-drop rule discarded progress and non-transition events | `(revision, sequence)` ordering |
| R-14 | Med | `delegate` refusal list incomplete for AC-09 | Full list; AC-09 names expected codes |
| R-15 | Med | Idempotency checked last, so retries could fail after state changes | Replay right after schema check |
| R-16 | Med | `child-tasks` semantics and outcome delivery undefined | Over terminal states; outcomes in `wakeReason.children` |
| R-17 | Med | `payloadRef` not dereferenceable | Event payload inline |
| R-18 | Med | R-37 not covered by any AC; roadmap put it in M2 | AC-20; M2-01 rescoped |
| R-19 | Med | R-02/03/06/22/31 had no AC; several mappings wrong | AC-15…AC-18 added; mappings fixed; AC-13 uses specialist profile |
| R-20 | Med | Handler could not build a `DelegationRequest` without generating keys | `DelegateInput`; runtime fills key, correlation, parent |
| R-21 | Med | `TaskHandle.status` not task states; record types and instance creation missing | Fixed; record types and instance operations added |
| R-22 | Med | Registry sketch used undefined types and a competing `AuthorizationContext` | `TrustedPrincipal` everywhere; types defined |
| R-23 | Low | Leftover pause/resume and "resumes executions" wording | Reworded |
| R-24 | Low | Activation counter and retire semantics inconsistent | One rule each in the runtime contract |
| R-25 | Low | P0/P1 vs M1 assignment; undefined X-items; no claim API | P1 "M1 (basic)" defined; X-items inlined; claim/release added |
