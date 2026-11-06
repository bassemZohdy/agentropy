# 2026-11-06 — M3 benchmarks (FEAT-028.7)

**What this is:** measured numbers for the runtime on its two store adapters, used to set the targets in [SLOs](../slo.md). Source: `packages/testkit/test/benchmarks.test.ts`, which prints one `[bench]` JSON line per case on every run (locally and in CI). Re-run it to compare: `pnpm exec vitest run packages/testkit/test/benchmarks.test.ts`.

## Setup

- Development container, Node 22.23, 2 vCPU. Two consecutive runs; ranges below cover both.
- Trivial handler (returns its input) unless stated; fake clock; policy, grant and audit-intent checks on every acceptance and dispatch; outbox relay and inbox projection active.
- SQLite: `node:sqlite`, WAL, `synchronous=FULL`, temp directory. PostgreSQL: **PGlite** (PostgreSQL compiled to WASM, one in-process connection) — a functional stand-in, *not* representative of a PostgreSQL server.

## Results

| Case | SQLite | PostgreSQL (PGlite) |
|---|---|---|
| Acceptance throughput (200 tasks, sequential `delegate`) | 358–385 tasks/s | 63–70 tasks/s |
| Completion throughput (same 200 tasks, one worker, pool 8) | 293–313 tasks/s | 47 tasks/s |
| Acceptance latency p50 / p95 | 1.7–2.0 / 2.8 ms | 12–14 / 17–19 ms |
| Accept-to-complete latency p50 / p95 (idle runtime) | 6.1–7.1 / 8.4–9.7 ms | 40–46 / 55 ms |
| Recovery: crashed worker held 8 leases (lease 30 s) | all 20 tasks done 58–61 ms after expiry | all 20 done 430–513 ms after expiry |
| 1 / 2 / 4 in-process workers, 120 tasks, 5 ms handler I/O | 276–333 / 282–286 / 285–303 tasks/s | — |

## Reading the numbers

- **Each activation is several fsync'd transactions.** SQLite throughput is bound by `synchronous=FULL`; this is the price of `durable-execution`.
- **PGlite is slow by construction** (WASM, one connection, no parallelism). Its numbers prove the adapter works under load; PostgreSQL server numbers must be measured on a real deployment (FEAT-028.8) before PostgreSQL SLOs are set. The cost of the ADR-0028 sequence counter row cannot be seen here, because a single connection serializes everything anyway.
- **In-process workers do not add throughput.** Workers in one process share one store connection, whose transactions are serialized; extra workers only help when handlers spend time outside the store and the pool is saturated. Scaling out means separate processes or hosts on a database server; the multi-worker suite proves correctness for that, not speed.
- **Recovery time is dominated by the lease.** Detection takes `leaseMs` (60 s by default); after that, the surviving worker drains the recovered work in well under a second at this size.

## CI

GitHub-hosted runners (Node 24) print their own `[bench]` lines in the test log of every push. First CI run (run 42144524246, Node 24.22):

| Case | SQLite | PostgreSQL (PGlite) |
|---|---|---|
| Acceptance / completion throughput | 407 / 296 tasks/s | 60 / 49 tasks/s |
| Acceptance latency p50 / p95 | 1.6 / 4.5 ms | 13.2 / 18 ms |
| Accept-to-complete p50 / p95 | 5.3 / 8.8 ms | 47 / 58 ms |
| Recovery drain after lease expiry | 64 ms | 463 ms |
| 1 / 2 / 4 in-process workers | 320 / 277 / 279 tasks/s | — |

The CI numbers are within the development-container ranges, and every [SLO](../slo.md) target holds on both machines.
