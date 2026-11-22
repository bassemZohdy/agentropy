# 2026-11-20 — Review of the changes since the 2026-11-13 project review

**What this is:** a read of the source changes from commit `011d128` (the baseline of the [2026-11-13 project review](2026-11-13-project-review.md)) to `be90b8b` (`main` after the release-preparation merge): about 6,000 changed lines in `packages/*/src`, made by the fixes that review led to, and not read as a whole since. Three reviewers split the diff by area (storage, audit and outbox; task lifecycle, registries and the sample host; network-facing code) and reported only findings they reproduced or could show plainly from the code. Each finding was then fixed on its own, with a test that failed before the fix.

Severity: **high** = a production deployment would hit it; **medium** = limits a supported use or weakens a guarantee; **low** = hygiene or an edge of configuration.

How each finding was established: **run** = reproduced with a test or script; **read** = follows from the code as written.

## Findings

| ID | Sev | Finding | Evidence | Root |
|---|---|---|---|---|
| P-01 | medium | A remote child marked for cancellation (FEAT-070) whose peer had already finished it was sent `CancelTask` on every sync and never asked for its state: the refusal (`InvalidState`) only rescheduled the poll, so the projection stayed open, a cancel went out every `sync.maxMs` and compaction never removed it | run: 10 cancel calls, 1 `GetTask`, projection still `created`; `packages/runtime/src/remote.ts` `poll` | FIX-080 |
| P-02 | medium | `delegate` checked only that the parent existed, not that it was open: a handler that ignored its abort signal and was fenced after `cancelGraceMs` could still delegate, and a remote delegation whose peer call outlasted the parent stored its projection after `endChildren` had run, so neither child was ever cancelled | run: a fenced handler's delegate succeeded and the child stayed `waiting` under a `cancelled` parent; `packages/runtime/src/task-service.ts`, `remote.ts` | FIX-081 |
| P-03 | medium | Audit `verify` and `exportLog` re-read at most twice when a disposal committed during their paged read, then returned the last result unchecked: a retention job disposing in a loop made `verify` record `{ok: false}` permanently for a sound chain, and `exportLog` return a bundle with a gap | run: SQLite, `dispose` between pages of each pass; `packages/runtime/src/audit.ts` `steady` | FIX-082 |
| P-04 | low | Compaction swept open inbox entries by `pending: 0` only; entries written before the indexed `pending` field existed have it null (also after the adapters' backfill), so acknowledged legacy entries were kept forever | run: memory store, one of two identical acknowledged entries removed; `packages/runtime/src/compaction.ts` | FIX-083 |
| P-05 | medium | Acceptance read each process's in-memory tool and skill status, not the status FEAT-074 keeps in the store: with two workers, a tool activated on one was refused by the other, and one revoked there was still accepted and pinned, failing at its first call | run: two registries on one SQLite store; `packages/runtime/src/tools.ts`, `skills.ts`, `app.ts` | FIX-084 |
| P-06 | medium | The MCP client read the reply to a notification (`notifications/initialized`, sent on every handshake) with no size cap, which TASK-068 had added only to requests; error replies were thrown without releasing their body | run: 50 MiB read against a 1 MiB cap; the regression test was killed for lack of memory before the fix; `packages/runtime/src/mcp.ts` | FIX-085 |
| P-07 | low | Host timer settings had no upper bound: Node shortens a delay above 2^31-1 ms to 1 ms, so `AGENTROPY_DRAIN_MS=3000000000` meant no drain at SIGTERM and an oversized tick or compaction interval a busy loop; `LocalApp.start` had the same gap | run: `parseHostEnv` accepted the value, a 3e9 ms timer fired after 2 ms; `packages/examples/src/host.ts`, `packages/runtime/src/app.ts` | FIX-086 |

## Fixed later the same day

| ID | Sev | Finding | Action taken | Root |
|---|---|---|---|---|
| P-08 | low | A projection with no cancel requested whose peer answers `NotFound` to `GetTask` is rescheduled indefinitely (backing off to one poll per `sync.maxMs`), so its parent waits until its own deadline. Failing it on the first `NotFound` would be wrong for a peer that answers it briefly (a restore, a misrouted request) | The projection fails with `NotFound` once the answers have lasted `sync.notFoundMs`, default 24 hours as the owner chose; [Communication v1](../contracts/communication-v1.md) revision 19 | FIX-087 |

## Checked and found sound

Bounded reply reading (chunked, compressed and mislabelled bodies; cancellation on overflow and abort), the A2A endpoint allow-list and its refusal of redirects, SSE stream accounting, MCP session re-establishment, Conductor tenant encoding, the MemoryStore undo log, `beforeSeq` and null range filters across the three store adapters, the new indexes and their backfill, chain-head positions, the outbox and audit-forwarder drain budgets, shutdown hand-over, `endChildren` against the transition table, fan-out counting, `governInstance` policy and audit, and the operation input schemas.

Two harmless leftovers were noted and not changed: the runtime's `abandoned` set can keep an id when `settle` had already passed its check, and `AGENTROPY_COMPACT_RETAIN_MS` is validated even when compaction is off.
