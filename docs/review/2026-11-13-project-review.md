# 2026-11-13 — Project review: fixes and improvements before 0.1.0

**What this is:** a read of every source file under `packages/*/src`, the deploy files, the workflows and the check scripts, at commit `011d128` (`main`, backlog holding only the release roots). Baseline at the time: `pnpm check` green (632 tests passed, 23 skipped live suites), and `check-deploy`, `check-doc-links`, `check-readiness` and `check-pack` all passed. Each finding names the code it comes from and the backlog root that owns it.

Severity: **high** = a production deployment would hit it; **medium** = limits a supported use or weakens a guarantee; **low** = hygiene, docs or developer experience.

How each finding was established: **run** = reproduced with a script against the built packages; **read** = follows from the code as written, not yet reproduced by a test (the root's first step is the failing test).

## Reproduced

| ID | Sev | Finding | Evidence | Proposed action | Root |
|---|---|---|---|---|---|
| N-01 | high | An unauthenticated request with a request target that is not a valid URL (`GET //`) makes `new URL` throw before the handler's `try`. The host calls the handler in a `void` async function, so the rejection reaches its `unhandledRejection` handler, which exits with status 1. The push receiver parses the path the same way | run: `ERR_INVALID_URL` as an unhandled rejection from `createA2AHttpHandler`; `packages/runtime/src/a2a-http.ts:119`, `packages/runtime/src/a2a-push-receiver.ts:150`, `packages/examples/src/host.ts:391-411` | Parse the path without throwing and answer `400`; the host's request callback contains any rejection | FIX-049 |
| N-08 | medium | A handler that returns an output `JSON.stringify` cannot serialize (BigInt, a cycle) is run again until its attempts are spent: the size check throws inside the disposition transaction, `settle` gives up after three tries, the execution stays `running` until its lease expires, and the task ends `Internal: Lease lost and attempts exhausted` | run: 3 handler runs, status `running` between lease expiries, then that outcome; `packages/runtime/src/runtime.ts:792-808`, `:897-900` | Treat an unserializable output like a schema violation: fail once with `SchemaViolation` (T8) | FIX-056 |

## Scheduler, leases and the tick

| ID | Sev | Finding | Evidence | Proposed action | Root |
|---|---|---|---|---|---|
| N-02 | high | `start()` appends a tick to a promise chain on every interval, whether or not the previous tick finished. A tick slower than the interval (a slow store, policy point or peer) queues ticks without bound, and `stop()` waits for all of them | read: `packages/runtime/src/app.ts:841-851` | Skip an interval while a tick is in flight | FIX-050 |
| N-03 | high | Leases are renewed only at the start of a tick, and not at all once `stop()` has cleared the interval and waits for running executions. A tick or a shutdown longer than `leaseMs` lets another worker on the same store recover a live execution: the work runs twice and the first result is fenced | read: `packages/runtime/src/runtime.ts:239-241`, `:1046-1059`; `packages/runtime/src/app.ts:845-851` | Heartbeat on its own timer until the pool is empty; revise the [runtime contract](../runtime-contract.md) | FIX-051 |
| N-04 | medium | Sweeps run in sequence with no containment. The Conductor poll throws `ProviderUnavailable` while Conductor is down, which ends the poll before any wake-up is evaluated and skips the pool tick behind it | read: `packages/runtime/src/wakeups.ts:112-114`; `packages/runtime/src/app.ts:590-599`; `packages/workflow-conductor/src/index.ts:91-113`, `:216-220` | Report a failing sweep (`agentropy.scheduler.errors`) and carry on | FIX-052 |
| N-05 | high | Remote projections are refreshed inside the tick, one after another, with no timeout and no abort signal. A peer that accepts the connection and never answers holds the scheduler for as long as the HTTP client waits | read: `packages/runtime/src/remote.ts:297-327`; `packages/runtime/src/a2a-client.ts:196-211`; `packages/runtime/src/app.ts:450` | A timeout per peer call, and refresh outside the tick's critical path | FIX-053 |
| N-16 | medium | The outbox relay and the audit forwarder loop until nothing is pending, although `batchSize` is documented as "bounded work per tick"; a backlog after an outage becomes one long tick. The relay takes its leader lease once per drain and never renews it during one | read: `packages/runtime/src/outbox.ts:61-62`, `:164-193`, `:234-291`; `packages/runtime/src/audit.ts:117-132` | A time budget per drain call; renew the lease while draining | FIX-064 |
| N-24 | medium | Shutdown waits for running executions without bound and does not hand them over: past the pod's grace period they are killed and resume only after lease expiry | read: `packages/examples/src/host.ts:247-262`; `deploy/kubernetes/statefulset.yaml:22` | Bounded drain, then abort the handlers and expire their leases | FEAT-072 |

## Security and governance

| ID | Sev | Finding | Evidence | Proposed action | Root |
|---|---|---|---|---|---|
| N-06 | high | The A2A provider supports any target with an `endpoint`, and a handler supplies that endpoint in `delegation.delegate`. The only guard is the policy decision for `delegation:delegate` on a `remote-agent` resource; a policy that allows the action (the sample allow-list does) lets an agent send the runtime's bearer credential to any URL, `http:` included. The [threat model](../security/threat-model.md) covers discovery (TM-34) and push webhooks (TM-35), not this path | read: `packages/runtime/src/a2a-client.ts:149-151`, `:163-195`; `packages/runtime/src/remote.ts:124-147`; `packages/examples/src/host.ts:63-78` | A required endpoint allow-list on the provider, `https:` unless allowed; revise [Communication v1](../contracts/communication-v1.md) and add a threat-model row | FIX-054 |
| N-09 | medium | `InstanceDirectory.create` takes `ownerId` from the request without comparing it to the caller, so a user can create an instance that appears in another user's list and inbox. Create, suspend, resume, retire, drain and share have no policy check and write no audit intent; only `upgradeInstance` does | read: `packages/runtime/src/registry.ts:180-225`, `:276-381`, `:454-482`; `packages/runtime/src/app.ts:718-725` | Owner guard (trusted services only for another owner), policy actions and audit intents; revise [Agent v1](../contracts/agent-v1.md) and [Security v1](../contracts/security-v1.md) | FIX-057 |
| N-12 | medium | The Conductor adapter ties a run to a tenant by the prefix `<tenantId>:` of its correlation ID. Tenant IDs may contain `:`, so tenant `a` passes the ownership check for runs of tenant `a:b`, and a completion is published to the text before the first `:`. A run that no longer exists in Conductor is polled forever, and the `reported` set never shrinks | read: `packages/workflow-conductor/src/index.ts:81`, `:139`, `:188-190`, `:235-246` | Encode the tenant unambiguously; report a vanished run as failed `NotFound`; bound the set | FIX-060 |
| N-26 | medium | Tool and skill lifecycle status lives in process memory. A suspend or revoke does not reach other workers and is lost at restart, when the host's bootstrap registers and activates the tool again | read: `packages/runtime/src/tools.ts:52-53`, `:229-246`; `packages/runtime/src/skills.ts:134-135`, `:269-282` | Keep the status in the store; revise [Tool v1](../contracts/tool-v1.md) and [Skill v1](../contracts/skill-v1.md) | FEAT-074 |
| N-22 | medium | Nothing in Agent v1 says what happens to the children of a cancelled or failed parent, and `terminate` leaves them running: they keep spending budget and causing effects for a result nobody waits for | read: `packages/runtime/src/task-service.ts:972-1070` | Decide and specify propagation to open children, local and remote | FEAT-070 |

## Correctness

| ID | Sev | Finding | Evidence | Proposed action | Root |
|---|---|---|---|---|---|
| N-07 | high | The host creates the `pg` pool without an `error` listener. `pg` emits `error` on the pool when an idle connection is dropped (a database restart or failover), and an unhandled `error` event ends the process; every replica goes at once. No connection, statement or lock timeout is set either | read: `packages/examples/src/host.ts:349-355`; `packages/store-postgres/src/index.ts:101-104`, `:131-135` | Listen and log; set the timeouts | FIX-055 |
| N-11 | medium | The MCP HTTP transport stores the session ID at `initialize` and never starts a new session. After a server restart every call answers 404 for the old ID and fails `ProviderUnavailable` until the process restarts. `clientInfo.version` is the literal `0.0.0` | read: `packages/runtime/src/mcp.ts:76-93`, `:286-330` | Re-initialize once on a 404 that carried a session ID; send the package version | FIX-059 |
| N-14 | medium | A2A `ListTasks` reads the caller's visible tasks oldest first and stops at 10,000 before sorting newest first. Beyond that the newest tasks are never listed and `totalSize` is wrong; every call reads up to 10,000 rows | read: `packages/runtime/src/a2a-server.ts:110`, `:421-435`; `packages/runtime/src/task-service.ts:564-627` | Page from the newest task | FIX-062 |
| N-15 | low | Fan-out is counted outside the accepting transaction (concurrent delegations can exceed `maxFanOut`); `getTaskByIdempotencyKey` reads `caller.tenantId` before checking the caller; a delegation by `target.definition` creates the instance before policy and schema checks and leaves it behind when they fail | read: `packages/runtime/src/task-service.ts:394-404`, `:637-649`, `:818-828` | Three guards in `TaskService` | FIX-063 |
| N-23 | medium | Every built-in operation declares `inputSchema: true`, so handler input is checked by hand or not at all. A malformed input (`null` to `delegation.getTask`) throws a `TypeError`, which becomes `Internal`, which is retried. `reasoning.complete` accepts any `maxTokens` | read: `packages/core/src/catalog.ts:20-29`; `packages/runtime/src/wakeups.ts:612-625`; `packages/runtime/src/runtime.ts:1008-1015` | Declare input schemas and validate before the provider runs; revise [Capability v1](../contracts/capability-v1.md) | FEAT-071 |
| N-30 | low | The stream count is checked before `await server.stream(...)` and incremented after it, so concurrent requests can pass `maxStreams`. A `401` carries no `WWW-Authenticate` header | read: `packages/runtime/src/a2a-http.ts:134-139`, `:180-196` | Count first; add the header | TASK-078 |

## Scale and retention

| ID | Sev | Finding | Evidence | Proposed action | Root |
|---|---|---|---|---|---|
| N-10 | medium | The human-action sweep runs on every tick and reads every request whose `dueAt` or `claimExpiresAt` has passed, whatever its status. Resolved and expired requests stay in those ranges until compaction, so the read grows with history | read: `packages/runtime/src/human-actions.ts:385-395` | Read `pending` and `claimed` only, through the status index | FIX-058 |
| N-17 | low | `TaskEventStream` keeps one (empty) listener set per task ever subscribed to | read: `packages/runtime/src/outbox.ts:367-385` | Remove the entry with its last listener | FIX-065 |
| N-18 | medium | Each compaction run reads every terminal task row ever written (compacted ones included) and the whole `inboundEvents`, `inbox` and `memories` collections, the last three in one transaction each. `retainMs` is not validated (a negative value compacts everything; `NaN` throws a `RangeError`). Counts are incremented inside transaction callbacks, which PostgreSQL may re-run | read: `packages/runtime/src/compaction.ts:53`, `:88-106`, `:125-150` | Indexed, batched reads; validate `retainMs`; count outside the callbacks | TASK-066 |
| N-19 | medium | `verify`, `exportLog`, `anchor` and `dispose` load a tenant's whole audit chain in one transaction; `anchor` does so to learn the last row and the count. Under SERIALIZABLE that read conflicts with every acceptance of the tenant | read: `packages/runtime/src/audit.ts:356-361`, `:403-406`, `:424-432`, `:560-571`, `:615` | Keep the chain position in the head row; work in pages | TASK-067 |
| N-20 | medium | Size limits on peer replies are applied after the whole body is in memory (MCP, federation cards) or not at all (A2A client, model responses). The reasoning timeout and the abort link end when the headers arrive, so a stalled body is not covered. A non-JSON A2A reply surfaces as `Internal`; a remote task's output is stored without the `maxOutputBytes` bound | read: `packages/runtime/src/mcp.ts:331-333`; `packages/runtime/src/federation.ts:194-195`; `packages/runtime/src/a2a-client.ts:159-160`; `packages/runtime/src/reasoning.ts:350`, `:383`; `packages/runtime/src/remote.ts:424-426` | Read with a cap; keep the timeout until the body is read; map and bound | TASK-068 |
| N-21 | low | `MemoryStore` clones the whole store at the start of every transaction, so a test or example run costs O(store size) per transaction | read: `packages/core/src/store.ts:199-212` | Roll back with an undo log | TASK-069 |

## Operations, deployment and release

| ID | Sev | Finding | Evidence | Proposed action | Root |
|---|---|---|---|---|---|
| N-13 | medium | The six publishable packages have no `README.md`, `keywords`, `homepage` or `bugs`; their npm pages would be empty at the first publish | read: `packages/*/package.json`; no `packages/*/README.md` | A README and metadata per package, required by `check-pack` | TASK-061 |
| N-25 | low | The host passes `Number(env.X)` straight on: a non-numeric `AGENTROPY_TICK_MS` becomes a 1 ms interval. It detects being the main module by comparing `import.meta.url` with `file://` + `argv[1]`, which fails for encoded or Windows paths. [Operations](../operations.md) says to run `compact` on a schedule, and the host offers no way to | read: `packages/examples/src/host.ts:366`, `:377`, `:397`, `:414` | Validate at start; compare by path; an optional compaction schedule | FEAT-073 |
| N-27 | low | Audit forwarding stops at the first row the sink refuses and retries it forever, by design, but no metric counts the failures and `/readyz` shows `outboxStuck` only | read: `packages/runtime/src/audit.ts:134-156`; `packages/core/src/telemetry.ts:60-69`; `packages/examples/src/host.ts:127-131` | A failure metric in [Observability v1](../contracts/observability-v1.md) and `auditStuck` on `/readyz` | FEAT-075 |
| N-28 | low | The manifests have no startup probe (a long schema migration is killed by the liveness probe), the PostgreSQL variant has no PodDisruptionBudget, and only the SQLite variant is applied to a cluster in CI | read: `deploy/kubernetes/statefulset.yaml`, `deploy/kubernetes-postgres/deployment.yaml`, `.github/workflows/ci.yml` (`cluster` job) | Probe, budget and a kind run of the PostgreSQL variant | TASK-076 |
| N-29 | low | The CI workflow has no `concurrency` group and no job timeouts, and tests run on Node 24 only while the image runs Node 26 | read: `.github/workflows/ci.yml`; `deploy/Dockerfile` | Cancel superseded runs, time out jobs, add a Node 26 job | TASK-077 |

## Checked and found sound

- Store adapters: revision CAS, commit-ordered `seq`, write buffering and retry in PostgreSQL; `BEGIN IMMEDIATE` under a mutex in SQLite. No finding beyond N-21.
- Fencing of late results by lease epoch, the dispatch gate's CAS on task and gate revision, and idempotent acceptance under a concurrent duplicate.
- Push webhooks: allow-list, no redirects, sealed secrets, per-task HMAC tokens compared in constant time, authentication before any body read.
- Skill loading: symlinks refused, paths confined to the registered root, content digest checked on every load.
- Federation: only configured peers are fetched, endpoints must be on an allowed origin.

## Backlog mapping

| Root | Findings |
|---|---|
| FIX-049 | N-01 |
| FIX-050 | N-02 |
| FIX-051 | N-03 |
| FIX-052 | N-04 |
| FIX-053 | N-05 |
| FIX-054 | N-06 |
| FIX-055 | N-07 |
| FIX-056 | N-08 |
| FIX-057 | N-09 |
| FIX-058 | N-10 |
| FIX-059 | N-11 |
| FIX-060 | N-12 |
| TASK-061 | N-13 |
| FIX-062 | N-14 |
| FIX-063 | N-15 |
| FIX-064 | N-16 |
| FIX-065 | N-17 |
| TASK-066 | N-18 |
| TASK-067 | N-19 |
| TASK-068 | N-20 |
| TASK-069 | N-21 |
| FEAT-070 | N-22 |
| FEAT-071 | N-23 |
| FEAT-072 | N-24 |
| FEAT-073 | N-25 |
| FEAT-074 | N-26 |
| FEAT-075 | N-27 |
| TASK-076 | N-28 |
| TASK-077 | N-29 |
| TASK-078 | N-30 |
