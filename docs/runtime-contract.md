# Agent task lifecycle, durability and version compatibility

**Status: proposed contract design**, adapted from langgraph-flows' fixed FlowRun transition rules, async-first run semantics and version-pinned durable execution. This does **not** copy the Flow type system.

## Three lifecycle axes

**AgentInstance lifecycle:** `registered -> available <-> suspended -> retired` (logical identity; retiring does not erase history).  
**DelegatedTask lifecycle:** `created -> assigned -> running <-> waiting -> completed|failed|cancelled`. An assigned task can be cancelled before running. A task may enter `waiting` on approval, event, timer or resource budget, without occupying a worker.  
**Execution attempt lifecycle:** `queued -> leased -> running -> checkpointed/waiting -> resumed -> completed|failed|aborted`. Recovery can create a successor attempt with a fenced lease; a task remains the logical objective.

Exact edge validation is to be specified by an explicit versioned transition table during Milestone 0; states above are intended behavior, **not** an implementation claim.

## Operation contract

| Operation | Eligible task state | Additional requirement |
|---|---|---|
| delegate/start | New / accepted only | Authorize principal, target agent, capabilities, schema before acceptance |
| status | Any visible task | Authorized read |
| result | Completed | Active tasks return typed NotReady, failed/cancelled return typed terminal outcome |
| cancel | Created, assigned, running, waiting | Advertised cancellable capability; best-effort downstream stop; no claim of rollback |
| provideHumanInput | Waiting for that exact request | Advertised human-approval/input capability; atomic assignee/deadline/idempotency checks |
| pause/resume | Only explicitly supported runtime states | Advertised pausable capability and compatible provider |
| retry | Failed/cancelled and policy-authorized | New execution attempt or new task as explicitly specified; terminal task never silently reopened |

Not all providers support pausing live work. Missing capability fails before invoking an adapter, rather than using a no-op. Execution's richer provider states map to the public task status without exposing Temporal or LangGraph internals.

## Async-first result

`delegateTask` returns a task reference after validation and durable acceptance (if requested), not the final agent result. Transport timeout can leave acceptance uncertain; resolve via idempotency key/status lookup. Polling/streaming events may follow; `executeAndWait(timeout)` may be offered as a bounded convenience without changing underlying state.

## Durability and crash semantics

Durability guarantee describes *which state survives*, *which side effects may repeat*, *how wake-up intent is recovered* and *what errors are visible*. Durable task metadata and snapshots, outstanding wake-ups, event/outbox and version binding need a persisted authority. Leased execution capacity may be lost and reacquired without changing logical task ownership. Duplicate triggers are safe through idempotency and version fencing; exactly-once external actions are not assumed.

## Version pinning and upgrade

On task acceptance, snapshot **AgentDefinition version, AgentProfile version, effective capability contract versions, provider binding/build revision and input schema version**. AgentInstance may evolve for *future* tasks, but in-flight tasks must run against compatible semantics. Some providers require history replay compatibility or worker version routing; pinning a string does not guarantee durable replay. Unsupported old execution histories require a controlled migration, draining or explicit failure.

## Required contract tests

- Every legal/illegal lifecycle edge and operation-capability guard.
- Start acceptance, unknown-acceptance timeout, query, and result-before-completion behavior.
- Crash/restart while waiting, lease theft/expiry and stale-worker fencing.
- Duplicate commands and events; transient transport retry; event ordering and reconciliation.
- V1 task suspended through V2 rollout, rollback and incompatible provider/history handling.
- Non-durable immediate task clearly discloses loss on process restart; no false durability guarantee.
