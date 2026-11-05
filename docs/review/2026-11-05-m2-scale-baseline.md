# 2026-11-05 — M2 monitoring scale baseline (FEAT-027.4)

**What this is:** a first measured baseline for the single-process runtime, not a target or an SLO (numeric targets are M3-06). Numbers come from `packages/testkit/test/scale.test.ts`, which prints a `[scale-baseline]` line on every run; re-run it to compare.

## Scenario

- 200 standing monitoring tasks, each subscribed to one of 20 symbols (10 tasks per symbol), each completing after 5 events.
- 100 events published (5 per symbol) through the trusted ingress, back to back.
- SQLite store (`node:sqlite`, WAL, `synchronous=FULL`) in a temp directory; pool size 16; fake clock; policy and grant checks on every dispatch and protected effect; outbox relay and inbox projection active.

## Result (development container, Node 22, 2 vCPU)

| Measure | Value |
|---|---|
| Activations | 1,200 (200 initial + 1,000 event-driven) |
| Setup (200 instances + 200 delegations + first activations) | ~0.9 s |
| Event processing (100 events → 1,000 activations) | ~3.7 s |
| Event-driven activations per second | ~270 |
| Consumed mailbox rows removed by compaction | 1,000 |

CI (Node 24, GitHub-hosted runner) prints its own line in the test log.

## What the suite also verifies

- **Back-pressure:** with `mailboxLimit: 3`, a suspended watcher buffers three events and drops later ones for that subscription; drops are counted on the subscription (`dropped`, `lastDroppedEventId`) and reported by `WakeupService.offer`.
- **Lease heartbeat:** a worker renews the leases of executions it is still running on every tick, so a second worker on the same store does not recover them as lost; without renewal the same situation is recovered (control case).
- **Compaction:** `compact(retainMs)` removes consumed mailbox rows, inbound-event dedupe records older than the retention window, and published outbox rows and wake-ups of tasks that ended before it. Duplicate inbound events are detected only inside the window.

## Observations for later milestones

- Every activation is several fsync'd transactions; throughput is bounded by `synchronous=FULL`. Batching relay deliveries and grouping a wake-up fire with its lease would cut transaction count (M3 PostgreSQL work should measure the same scenario).
- `find` without a matching index scans in memory (mailbox counts per subscription, compaction sweeps); fine at this scale, to be indexed before multi-thousand standing tasks.
