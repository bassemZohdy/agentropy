# Service level objectives (M3-06)

**Status:** revision 1 (2026-11-06), set from the [M3 benchmarks](review/2026-11-06-m3-benchmarks.md). Targets apply to the **reference single-node deployment**: one runtime process on the SQLite adapter with `durable-execution`, trivial handlers, default limits. They describe what Agentropy itself adds; handler, model, tool and network time come on top and belong in the application's own SLOs.

| Objective | Target | Measured (benchmarks) | Notes |
|---|---|---|---|
| Acceptance latency (`delegate` returns a handle), p95 | ≤ 10 ms | 2.8 ms (CI 4.5 ms) | Includes policy, grant and audit-intent writes |
| Accept-to-complete overhead, trivial handler, idle runtime, p95 | ≤ 50 ms | 8.4–9.7 ms (CI 8.8 ms) | Scheduler interval not included (`runUntilIdle` in the benchmark; add `start(intervalMs)` latency in production) |
| Sustained completion throughput per node | ≥ 150 tasks/s | 293–313 tasks/s (CI 296) | One worker, pool 8; bound by fsync |
| Recovery after a worker crash | work resumes within `leaseMs` + one scheduler interval + 1 s | 58–61 ms after lease expiry | Default `leaseMs` 60 s; lower it for faster detection |
| Accepted tasks lost on a durable store | 0 | 0 in every recovery and crash test | `durability: none` runtimes disclose loss instead |
| Duplicate dispatch of one execution | 0 | 0 across workers and processes | Effects use step keys; providers must honor idempotency keys |

**PostgreSQL:** no targets yet. The only measurements are on PGlite (embedded WASM PostgreSQL), which is not a server. Targets will be set from measurements on a PostgreSQL server deployment (FEAT-028.8).

**How to check:** run `pnpm exec vitest run packages/testkit/test/benchmarks.test.ts` on the target hardware and compare its `[bench]` lines with the table. The suite's own assertions are floors an order of magnitude below these targets, so CI noise does not fail builds; a target miss is found by reading the lines, not by a red test.
