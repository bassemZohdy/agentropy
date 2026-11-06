# ADR-0028: PostgreSQL store adapter

- Status: Accepted (2026-11-06)
- Resolves: M3-07 ("PostgreSQL store adapter passing the same conformance suite", [ADR-0017](0017-first-persistence-and-activation.md)). Builds on [ADR-0027](0027-m1-setup-choices.md) item 4.

## Context

The SQLite adapter is single-process and not highly available (ADR-0017). Multi-worker operation (M3-02) and production deployment (M3-08) need a shared database. The `Store` port in `packages/core/src/store.ts` is driver-neutral: JSON documents with revision compare-and-swap, a few indexed scalar fields per collection, a store-wide insertion sequence, and atomic transactions.

## Decision

1. **Package:** `@agentropy/store-postgres`, depending only on `@agentropy/core`. It talks to a minimal client port (`query(text, params)`), or a pool port (`connect()` → client with `release()`). node-postgres `Pool` and embedded PGlite satisfy these as-is, so Agentropy ships **no database driver**; the application picks one.
2. **Isolation:** each `transaction` is `BEGIN ISOLATION LEVEL SERIALIZABLE … COMMIT`. A serialization failure (`40001`) or deadlock (`40P01`) re-runs the callback with jittered back-off, up to `maxRetries` (default 8), then fails `StaleRevision` with `reason: "serialization"`. **Transaction callbacks may therefore run more than once and must only touch the store** (Store port rule, now stated in the port documentation).
3. **Sequence:** `seq` is taken from a counter row updated inside the transaction. The row lock is held to commit, so seq order equals commit order and `afterSeq` readers (outbox relay, inbox projector) never skip a late-committing row. This serializes inserting transactions on one row; measured cost is a FEAT-028.7 benchmark item.
4. **Indexes:** each indexed field has a numeric column and a text column in the `"C"` collation. Equality, ranges and ordering then match the in-memory reference adapter exactly (nulls first, code-unit string order, booleans as 0/1).
5. **Schema:** tables live in a configurable schema (default `agentropy`); `schema_migrations` records the version. Migration runs under a transaction-scoped advisory lock, so many workers can start at once. A database migrated by a newer adapter is refused with `IncompatibleVersion`. Versioned upgrades beyond v1 are FEAT-028.3.
6. **Errors:** raw driver errors never leave the adapter. Connection, resource and shutdown classes (`08`, `53`, `57P`, `58`) become `ProviderUnavailable` (retryable); anything else becomes `Internal`. Only the SQLSTATE is kept in `details`.
7. **Tests:** the shared Store conformance suite and the runtime run against **PGlite** (PostgreSQL compiled to WASM), in-process and offline, so CI needs no database service. Real-server concurrency (pool mode, several processes) is exercised by FEAT-028.2.

## Consequences

Same contract and conformance suite for SQLite, memory and PostgreSQL. Application code chooses and configures its driver, TLS and credentials. The single counter row bounds insert throughput; if benchmarks show it matters, a later ADR may move to commit-ordered sequences (e.g. a commit log) without changing the port.

## Alternatives

A `pg` dependency inside the adapter (couples Agentropy to one driver and its TLS/credential handling); `READ COMMITTED` with explicit row locks (callers would need to know which rows to lock); a PostgreSQL `SEQUENCE` for `seq` (values are allocated out of commit order, so paging readers could skip rows); a `pg-mem` emulator for tests (not real PostgreSQL semantics).
