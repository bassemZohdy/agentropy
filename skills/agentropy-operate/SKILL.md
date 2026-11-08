---
name: agentropy-operate
description: Operate and troubleshoot a running Agentropy runtime. Use when the user sees a failing or flapping readiness probe, a stuck scheduler or outbox, tasks that do not progress, wants to quarantine a misbehaving agent instance, plan retention and compaction, read the telemetry and SLOs, or recover after a worker crash.
license: Apache-2.0
compatibility: Agentropy checkout or a deployed Agentropy host. Metric and span names are the ones in docs/contracts/observability-v1.md.
metadata:
  project: agentropy
  audience: operators
---

# Operate Agentropy

References in the repository: `docs/operations.md`, `docs/runtime-contract.md`, `docs/contracts/observability-v1.md`, `docs/slo.md`.

## Triage by readiness

`GET /readyz` is the first thing to read.

| Answer | Meaning | Look at |
|---|---|---|
| 200 `ready` | Store answers a transaction and the scheduler is healthy | If tasks still stall, see "A task does not progress" |
| 503 `store-unavailable` | The store failed a probe transaction | Database reachability, credentials, disk. PostgreSQL timeouts show as `Timeout` |
| 503 `scheduler-stalled` | Three failed ticks in a row, or no good tick for 30 s | stderr (each failed tick is logged), the counter `agentropy.scheduler.errors`. The loop keeps running and recovers once the store does |
| 503 `shutting-down` | SIGTERM received | Normal during a rollout |
| 200 with `outboxStuck` | A failing consumer is holding back outbox rows | `OutboxRelay.stuck()` lists the rows. `agentropy.outbox.failures` counts failed deliveries. `AGENTROPY_OUTBOX_POISON_AFTER` gives up on a row after N failures and counts it in `agentropy.outbox.poisoned`, at the price of event order |

`/healthz` only says the process is alive. Do not restart a pod for `scheduler-stalled` before checking the store, because a restart does not fix a store outage.

## A task does not progress

1. `getTask` shows the status. `waiting` means a wake-up condition has not fired. Check the timer, the event subscription, the child task or the pending human action.
2. A `waiting` task past its deadline fails with `Timeout`. `budget.maxActivations` exhaustion fails with `BudgetExceeded`.
3. A task behind the dispatch gate is waiting for a re-authorization (`agentropy.dispatch.gated`, `agentropy.gate.reason`).
4. After a worker crash, work resumes within `leaseMs` (default 60 s) plus one scheduler interval. Measured recovery is about a second after lease expiry. Lower `leaseMs` for faster detection.
5. A handler that ignores its abort signal is fenced by `limits.maxActivationMs` (10 min) and the task fails with `Timeout`.
6. Retries: unclassified errors and `Internal` are retried with bounded backoff. Conflicts beyond the retry bound fail with `StaleRevision` and never leave a partial write.

## Quarantine a misbehaving instance

There is no separate quarantine state (ADR-0030). In order:

1. `suspendInstance`: no new tasks are accepted.
2. `revokeAuthority(grantRef)` for each grant its running tasks use. Handlers get an `AuthorityExpired` abort, their next protected effect is refused and the tasks wait behind the gate.
3. Inspect `listEffects(taskId)` and the audit log (`audit:read`).
4. Either `reauthorize` and `resumeInstance`, or cancel the tasks and `retireInstance`.

Every step is audited.

## Retention and compaction

Run `LocalApp.compact(retainMs, operator)` on a schedule, for example daily, as a trusted service. It removes standing state of ended work in transactions of 100 tasks and marks compacted tasks with `compactedAt`. Task rows themselves are never deleted by `compact`. The audit trail follows its own retention floors, legal holds and receipted disposal. The collection-by-collection table is in `docs/operations.md`.

Duplicate events are only detected inside the retention window, so do not set `retainMs` shorter than the longest redelivery you expect.

## Telemetry

Wire a `Telemetry` into `createLocalApp` (`openTelemetry({ api, tracer, meter })`), or set `AGENTROPY_OTLP_ENDPOINT` on the sample host. Useful series:

- `agentropy.tasks.accepted`, `agentropy.tasks.finished`, `agentropy.execution.duration`
- `agentropy.outbox.delivery_lag`, `.failures`, `.poisoned`
- `agentropy.store.conflicts` (serialization retries; a rising rate means contention)
- `agentropy.scheduler.errors`, `agentropy.mailbox.dropped`, `agentropy.trace.rejected`

Prompts, personal data and credentials are redacted from telemetry by design. Do not add them to span attributes.

## SLOs

`docs/slo.md` lists the accepted targets, with an SQLite table and a PostgreSQL table. The PostgreSQL latency figures scale with the database round trip (an acceptance is about 36 sequential statements), so measure on your own network:

```sh
env AGENTROPY_PG_URL=postgres://… pnpm exec vitest run packages/testkit/test/benchmarks.test.ts --silent=false
```

Read the `[bench]` lines and compare them with the table. The suite's own assertions are floors an order of magnitude below the targets, so a missed target does not turn the suite red.

## Never do

- Do not hand-edit store rows to unstick a task. Use the service operations so fencing and audit stay intact.
- Do not scale a SQLite StatefulSet beyond one replica.
- Do not disable policy checks to get past a denial. A denial is a decision. Read the audit entry first.
