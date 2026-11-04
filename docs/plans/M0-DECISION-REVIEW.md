# Milestone 0 — Decisions and architectural readiness

- Date: 2026-11-04
- Status: **Partially accepted** — M0-01 / M0-06 selected for M1; license, old ADR review and security/lifecycle decisions remain open. Not implementation authority.
- Source: [ADR-0016](../adr/0016-implementation-language.md), [ADR-0017](../adr/0017-first-persistence-and-activation.md), [security closeout](../review/2026-11-04-security-governance-closeout.md), [project plan](PROJECT.md)

## What has been reconciled

The TaskAgent profile now requires `durable-execution` in the capability catalog, README and ADR-0019. Scheduling remains optional. An intentionally non-durable specialist/custom profile remains allowed. This closes one documentation contradiction; it does **not** demonstrate durability in running code.

## Maintainer decisions required

### M0-01 — Implementation language and tooling: ADR-0016 (ACCEPTED)

**Recommendation:** Approve strict TypeScript + ESM + Node.js currently supported Active LTS, pnpm workspaces, Vitest, JSON Schema 2020-12 and one consistent lint/format tool. Confirm actual Node version at implementation start and choose schema authoring/validation libraries after a tiny offline feasibility test. Reason: public contracts are already TypeScript-shaped, and this is an embeddable library, not a workflow service.

**Caveat:** This does not establish a first-class Temporal/LangGraph TypeScript integration. Keep that provider decision deferred and separately validated.

**Decision recorded:** Accepted for M1. Remaining setup options: npm package scope and tested Node version floor.

### M0-06 — First persistence / scheduling: ADR-0017 (ACCEPTED)

**Recommendation:** Approve SQLite WAL in a *single process* behind a transaction-capable Store port; in-process event bus, polling wake-up scheduler and persisted outbox for M1. Do not assert multi-writer HA or exactly-once external effects. Schema and conformance must preserve the later PostgreSQL option.

**Security rider:** before the protected change is reported committed, critical audit intent must be atomically recorded with the authoritative state transition or transactional outbox; test failures. Idempotent effect journal entries must be committed at invocation/effect time, not only at handler completion.

**Decision recorded:** Accepted for M1. Remaining setup options: scheduler polling defaults and supported SQLite adapter.

### M0-02 — OSS license / contributions

**Recommendation for discussion:** MIT or Apache-2.0; Apache-2.0 offers explicit patent grant and is common in infrastructure frameworks, MIT is simpler. Do not choose on the maintainer's behalf. Contribution policy DCO vs CLA, code ownership and release process also require a decision.

### X-01 — Earlier proposed ADRs

Review statuses of ADR-0008…0014 and ADR-0016…0018 individually against ADR-0019…0022. Older proposals remain proposed where specific mechanisms are unresolved. Do not batch-accept without inspecting incompatibilities.

### M0-05 — Security-wait lifecycle and trust boundary

ADR-0021's `policy-waiting` terminology is a *reason*, not a new task status. A running task can yield to existing `waiting` through T4 if safe. For tasks still `created` or `assigned`, whether to defer activation with durable registration versus add a versioned lifecycle mechanism remains open. No protected effect may execute while policy is indeterminate. Specify the trusted principal source, grant narrowing and denial/no-state-leak tests before coding.

### G0-05 — POC acceptance gates

Current AC-01…AC-20 are unchanged. SEC-01…SEC-07 are proposed additional tests in [POC scope](../poc-scope.md). **Recommendation:** SEC-01/02/03/04/07 basic tests for M1 (offline fake PDP/audit/identity), broader A2A and credential tests in M2, full legal-hold/archive integrity in M3. Require explicit scope approval and keep implementation small.

## Architecture closure evidence before todo-skills migration

1. ADR-0016, ADR-0017 and license decision explicitly recorded.
2. Security waiting/activation semantics formally reconciled in canonical runtime contract, including errors and outbox.
3. Core contracts, domain model, requirements, docs and accepted ADRs agree; no undocumented API guarantees.
4. M1 security acceptance additions confirmed, with test ownership and exact runnable commands after scaffold.
5. Backlog migration crosswalk validates every old item; todo-skills lint and 120-line active queue comply.
6. Final signoff distinguishes **architecture accepted** from **running code validated**.

## Execution safety

This record is deliberately a decision proposal. No license file, package manifest, runtime dependency, test suite or `TODO.md` schema migration has been generated from it.
