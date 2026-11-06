# Provider conformance kit and deployment failure matrix

**Status:** FEAT-028.6 (2026-11-06). Covers X-10 and C-05.

`@agentropy/testkit` holds offline suites that any adapter has to pass. They are plain functions: pass your test runner's `describe`/`it`/`expect`, plus a factory for your adapter. They need no network, because `blockNetwork()` (also exported) makes outbound TCP, DNS and `fetch` fail.

| Suite | For | What it checks | Run here against |
|---|---|---|---|
| `defineStoreConformance` | `Store` adapters | insert/get/CAS, rollback across collections, serialized read-modify-write, indexed find and ordering, durable reopen | memory, SQLite (file and `:memory:`), PostgreSQL on PGlite |
| `defineCommunicationConformance` | `AgentCommunicationProvider`s | idempotent delegation, tenant ownership, typed errors, events, receive | direct, A2A 1.0, custom broker sample |
| `defineWorkflowEngineConformance` | `WorkflowEngine` adapters | idempotent start per key, tenant-scoped status (`NotFound`, no disclosure), terminal mapping with output or code, one completion report per run with its tenant | fake engine, Conductor (webhook + server idempotency, polling + correlation lookup) |

Example for a new workflow adapter:

```ts
import { defineWorkflowEngineConformance } from '@agentropy/testkit';
defineWorkflowEngineConformance({ describe, it, expect }, 'my-engine', () => ({
  engine: new MyEngineAdapter(/* fake transport */),
  workflow: 'invoice',
  finish: async (runId, outcome) => { /* drive the run to its end, then let the adapter report it */ },
}));
```

The packages are private in this repository (no npm release yet). Provider authors can copy the suite files or depend on the workspace package.

## Second workflow adapter: Conductor

`@agentropy/workflow-conductor` maps the `WorkflowEngine` SPI to Conductor's REST API (Conductor OSS and Orkes): `POST /api/workflow` to start, with correlation ID `<tenant>:<key>` and either server-side idempotency keys or a correlated-run lookup; `GET /api/workflow/{id}` for status; completion by status webhook (`handleStatusEvent`, which re-reads the run, so a forged payload cannot complete it), polling (`poll`) or `reconcile(runIds)` after a restart. RUNNING/PAUSED → running, COMPLETED → completed, FAILED → `TaskFailed`, TIMED_OUT → `Timeout`, TERMINATED → `TaskCancelled`; 401/403 → `AuthorityExpired` (`kind: credential`), 5xx/429/unreachable → `ProviderUnavailable`.

Limitations: the SPI has no pause, resume or terminate, so the adapter does not map them; with the `lookup` strategy two simultaneous starts with the same key can both create runs (use a server that supports idempotency keys to avoid that); the adapter keeps no state, so a restarted process must `reconcile` the runs it still waits for (or rely on Conductor retrying the webhook). Verified by `packages/workflow-conductor/test/conductor.test.ts` against an in-process fake of the REST API; no live Conductor server runs in CI.

## Per-application isolation and deployment failure matrix (R-28, R-30)

What happens when a part fails, and which test shows it.

| Failure | Expected behaviour | Evidence |
|---|---|---|
| Two applications (app contexts) in one process | Separate definitions, instances, tasks, idempotency and inboxes | `packages/testkit/test/isolation.test.ts` |
| Process killed while a task waits | Task resumes from its checkpoint on the next event; duplicate inbound events appended once | `packages/testkit/test/recovery.test.ts` |
| Process killed mid-transaction | Uncommitted writes are gone, committed ones survive | `packages/store-sqlite/test/sqlite-store.test.ts` |
| Worker stalls past its lease | Another worker recovers and retries; the stalled worker's late result is fenced | `packages/testkit/test/multi-worker.test.ts` |
| Several worker processes on one database | Each task dispatched exactly once | `packages/testkit/test/multi-worker.test.ts` |
| A grant revoked through one worker | Another worker's shared decision cache stops serving its allow within `syncMs` | `packages/testkit/test/multi-worker.test.ts`, `packages/runtime/test/policy-cache.test.ts` |
| Outbox relay holder crashes | Lease expires; another relay replays in order | `packages/testkit/test/delivery.test.ts` |
| Tool or model provider outage | Retried with backoff on the same idempotency key | `packages/testkit/test/delivery.test.ts` |
| Policy decision point unavailable | Fail closed; dispatch gate with bounded retries | `packages/testkit/test/security.test.ts` |
| Audit store unavailable | Protected change is not committed (`AuditCommitUnavailable`) | `packages/testkit/test/security.test.ts` |
| Credential revoked or rotated away | Task waits behind the dispatch gate until reauthorized | `packages/testkit/test/authorization.test.ts` |
| Remote A2A peer unreachable | Local projection keeps its last observed state | `packages/testkit/test/remote-delegation.test.ts` |
| Workflow engine adapter restarted | `reconcile` re-reads runs and reports finished ones | `packages/workflow-conductor/test/conductor.test.ts` |
| Database written by an older release | Missing tables and index columns are added and backfilled | `packages/testkit/test/upgrades.test.ts` |
| Database written by a newer release | Refused with `IncompatibleVersion` | `packages/store-postgres/test/postgres-store.test.ts` |
| Durability `none` runtime restarts | Loss is disclosed; durable definitions are refused up front | `packages/testkit/test/recovery.test.ts` |
