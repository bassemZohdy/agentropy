# 2026-11-06 — PostgreSQL server benchmarks (FEAT-031)

**What this is:** the first measurements of the PostgreSQL adapter on a PostgreSQL **server**, following the [M3 benchmarks](2026-11-06-m3-benchmarks.md), which had only PGlite. They set the provisional PostgreSQL targets in [SLOs](../slo.md#postgresql).

## Setup

- PostgreSQL 17.11 (`postgres:17` image, default configuration, `synchronous_commit=on`) in Docker Desktop on Windows 11 (WSL2 backend, 16 vCPU and 14.5 GiB visible to the VM); client Node 24.16 on the same host, connected through Docker's port forwarder with node-postgres (`pg` 8.23), pool `max: 8`.
- Measured round trip (`SELECT 1`, warm connection): **p50 0.64 ms, p95 0.85 ms**.
- Same cases as the M3 suite: `AGENTROPY_PG_URL=postgres://… pnpm exec vitest run packages/testkit/test/benchmarks.test.ts`. Each store runs in a fresh schema.
- The shared Store conformance suite and two contention cases also ran on this server (`packages/store-postgres/test/postgres-server.test.ts`): 9 of 9 passed in three consecutive runs.

## Results

| Case | PostgreSQL server | PGlite, same machine | SQLite, same machine |
|---|---|---|---|
| Acceptance throughput (200 sequential `delegate`) | 30–33 tasks/s | 90 tasks/s | 368 tasks/s |
| Completion throughput (one worker, pool 8) | 18–19 tasks/s | 72 tasks/s | 128 tasks/s |
| Acceptance latency p50 / p95 | 28 / 32–33 ms | 9 / 15 ms | 2.2 / 3.1 ms |
| Accept-to-complete p50 / p95 (idle runtime) | 103–105 / 109–118 ms | 32 / 47 ms | 10 / 14 ms |
| Recovery drain after lease expiry (20 tasks, 8 lost leases) | 1.1–1.2 s | 0.29 s | 0.13 s |
| 1 / 2 / 4 in-process workers on one pool (120 tasks, 5 ms handler I/O) | 16–17 / 16–18 / 18–20 tasks/s (5 of 6 runs); one run 16 / 16 / **4.3** | — | 129 / 126 / 128 tasks/s |

## Where the time goes

A profile of 60 acceptances and their completions (statement counts through a counting pool wrapper):

| | Statements | Time per task | With `synchronous_commit=off` |
|---|---|---|---|
| Acceptance (`delegate`) | 36 | 31 ms | 28 ms |
| Completion (dispatch to result) | 62.5 | 58 ms | 49 ms |

- **Latency is round trips.** Every statement waits for the previous one; 36 × 0.64 ms is 23 ms of the 31 ms acceptance. Commit fsync is 10–15 %. On a network with a higher RTT, multiply: at 2 ms RTT an acceptance takes about 80 ms. Batching statements inside a transaction (one round trip for several index writes, or the counter update folded into the insert) is the main optimization lever; it is not done here.
- **PGlite was faster** only because it has no round trip at all (in-process WASM). It was never a performance proxy for a server.
- **Workers on one database barely add throughput** (16 → 19 tasks/s from one to four workers), and in one of six runs four workers collapsed to 4.3 tasks/s. Every writing transaction updates the store-wide `seq` counter row ([ADR-0028](../adr/0028-postgresql-store-adapter.md)), so concurrent writers serialize on it and conflicts are retried with backoff. The collapse is consistent with a retry storm on that row; the retries were not instrumented, so this is the likely, not the proven, cause.
- **Correctness under contention holds.** With 8 concurrent writers on one hot row (equal to the pool size) every transaction committed once; with 40, each transaction either committed whole or failed `StaleRevision` (`reason: "serialization"`) after the bounded retries, and the counter always equalled the number of commits: no lost or partial write.

## Follow-ups (not scheduled)

- Batch statements per transaction to cut round trips.
- Replace the single `seq` counter row with a sequence or commit-time ordering that does not serialize all writers, keeping "seq order equals commit order" for readers (ADR-0028 revision).
- Count serialization retries in telemetry so contention is visible in production.
- Measure on a dedicated database host (non-Docker, tuned `shared_buffers`, separate network) before treating the provisional targets as final.
