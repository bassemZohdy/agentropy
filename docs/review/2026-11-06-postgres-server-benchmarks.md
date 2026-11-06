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

## CI

The `postgres` CI job (GitHub-hosted Ubuntu runner, Node 24.22, `postgres:17` service container) prints the same lines on every push. First run, 42163263499 (9/9 server conformance and contention tests, 11/11 benchmark cases):

| Case | PostgreSQL server (CI) |
|---|---|
| Acceptance / completion throughput | 111 / 57 tasks/s |
| Acceptance latency p50 / p95 | 7.8 / 14 ms |
| Accept-to-complete p50 / p95 | 27 / 44 ms |
| Recovery drain after lease expiry | 0.52 s |
| 1 / 2 / 4 in-process workers | 53 / 36 / 36 tasks/s |

The runner's lower round-trip time makes everything about 3–4× faster than the Docker Desktop setup, and there adding workers **reduces** throughput (53 → 36 tasks/s): the clearest sign yet of writers serializing on the `seq` row.

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

## Round-trip reduction (FEAT-032.2, first pass)

Same Docker Desktop setup, same day:

| | Before | After |
|---|---|---|
| Statements per acceptance | 36 (6 transactions) | 16 (2 transactions) |
| Acceptance time (profile) | 31 ms | 16 ms |
| Acceptance throughput (200 sequential `delegate`) | 30–33 tasks/s | 70 tasks/s |
| Acceptance latency p50 / p95 | 28 / 32–33 ms | 14 / 33 ms |
| Accept-to-complete p50 / p95 | 103–105 / 109–118 ms | 87 / 126 ms |
| 1 / 2 / 4 in-process workers | 16–20 tasks/s | 19.5 / 18.4 / 20.1 tasks/s |

- An insert takes its `seq` value in the same statement (`WITH next_seq AS (UPDATE … RETURNING value) INSERT …`), not in a separate update. A rejected duplicate insert still uses up one value, so `seq` stays unique and in commit order but may have gaps.
- An audit append reads a per-tenant chain head row (`auditHeads`) instead of scanning the whole chain (R-26). A store written before the head existed is scanned once, on its next append.
- Acceptance reads the target instance and the idempotency record in one transaction, gives the tenant to the execution insert instead of reading the task again, and builds its handle from the task it wrote.
- From the third attempt on, a retried transaction first takes a per-schema session advisory lock, so repeat losers wait their turn instead of colliding again. Without it, the 20-writer conformance case ran out of retries in 1 of 4 runs; with it, 6 of 6 runs passed. The lock is taken before `BEGIN`: a SERIALIZABLE snapshot starts at the first statement, so a lock taken inside the transaction left the waiter with a stale snapshot and made the conflicts worse.
- CI run 42175166339 (same runner type as the first CI run): acceptance throughput 111 → 156 tasks/s, acceptance p50 / p95 7.8 / 14 → 5.9 / 11 ms, accept-to-complete p50 27 → 32 ms (completion is unchanged and runner timing varies), 1 / 2 / 4 workers 47 / 43 / 35 tasks/s: still falling as workers are added.
- The remaining 16 statements are a fence read, writes and the chain head read; reaching ≤ 12 needs several writes per round trip from the Store API. Completion (58 statements) is unchanged. Worker scaling is still flat: that is the `seq` row (FEAT-032.3).

## Commit-time `seq` (FEAT-032.3)

ADR-0028 revision 2 replaces the counter row with a sequence block drawn just before `COMMIT` under a transaction advisory lock, and pooled connections prefer index scans so disjoint writers do not share relation-wide predicate locks. Same Docker Desktop setup, same day:

| | Counter row | Commit-time `seq` |
|---|---|---|
| 1 / 2 / 4 in-process workers | 19.5 / 18.4 / 20.1 tasks/s | 22.7 / 25.1 / 26.9 and 26.7 / 28.5 / 32.3 tasks/s (two runs) |
| 8 writers inserting 5 rows each, serialization retries | some | 0 (`postgres-server.test.ts`) |

- Throughput now grows with workers instead of staying flat. The gain is bounded by the single in-process store pool and the Docker network; separate hosts are FEAT-032.4.
- A reader paging with `afterSeq` while 8 writers commit interleaved transactions sees every row exactly once (`postgres-server.test.ts`).
- Acceptance and completion latency are unchanged within run-to-run noise; an inserting transaction adds one statement (the stamp) before `COMMIT`.

## Buffered writes (FEAT-032.2)

ADR-0028 revision 3 keeps inserts, and updates of rows already read, in memory and sends them in one statement before the next read that could see them or at commit. Acceptance now runs: `BEGIN`, read instance, read idempotency record, `COMMIT`; `BEGIN`, read instance, read audit chain head, one statement with six writes, one statement drawing the seq block, `COMMIT`: 10 round trips, was 17.

| | Before | After |
|---|---|---|
| Round trips per acceptance | 17 | 10 (test: ≤ 12) |
| Acceptance throughput (200 sequential `delegate`) | 52.5 tasks/s | 78 tasks/s |
| Acceptance latency p50 / p95 | 18.3 / 24.2 ms | 11.8 / 16.5 ms |
| 1 / 2 / 4 in-process workers | 22.7 / 25.1 / 26.9 tasks/s | 20.2–21.1 / 22.7–24.3 / 25.5–26.4 tasks/s; unbatched in the same session 20.3 / 22.3 / 25.8 |

- The first attempt drew the seq block in the same statement as buffered updates. An update waiting on another transaction's row lock then held the seq lock, so every inserting commit queued behind it: some runs fell to 3–5 tasks/s. Drawing the block in a second statement whenever an update is buffered fixed it.
- About 1,200 serialization failures per multi-worker run, with or without buffering, come from workers' relays marking the same outbox rows published; they are retried, and they cost throughput.

## Follow-ups

- ~~Batch several writes per round trip~~: done, buffered writes (ADR-0028 revision 3, FEAT-032.2).
- Stop workers' outbox relays from marking the same rows published (about 1,200 retried conflicts per multi-worker run).
- ~~Replace the single `seq` counter row~~: done, commit-time `seq` (ADR-0028 revision 2, FEAT-032.3).
- Measure on a dedicated database host (non-Docker, tuned `shared_buffers`, separate network) before treating the provisional targets as final (FEAT-032.4).
- Serialization retries are now counted as `agentropy.store.conflicts` (FEAT-032.1).
