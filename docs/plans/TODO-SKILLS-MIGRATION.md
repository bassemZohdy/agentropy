# Agentropy TODO migration mapping for todo-skills

- Status: Staged mapping, not applied to TODO.md
- Date: 2026-11-04
- Source: legacy [TODO.md](../../TODO.md)
- Target standard: [todo-skills](https://github.com/bassemZohdy/todo-skills), `skills/todo/SKILL.md` and `skills/todo-plan/SKILL.md`.

## Preservation policy

Retain source IDs forever as provenance. At migration, generate a machine-readable ID crosswalk or Markdown table and verify that each M0/M1/M2/M3/D-/C-/X- item appears exactly once in either an active small leaf, a parent, a deferred milestone plan, or the archive, with its original status preserved. Do not assign completed status to work represented only by an accepted ADR.

## Proposed roots and lanes (not yet executable)

| todo-skills root (provisional ID) | Lane | Priority | Scope | Source task families | Gate |
|---|---|---|---|---|---|
| TASK-001 | contracts | P0 | Final architecture/requirements/ADR consistency review | M0-01…07, X-01, D-01…D-25 | G0-01…G0-05 |
| TASK-002 | ops | P0 | Confirm tooling, license, scaffold, offline test command | M0-01, M0-02, M0-08 | G0-04 |
| FEAT-003 | contracts | P0 | Agent, capability, schema and lifecycle contracts | M1-01…03 | TASK-001/002 |
| FEAT-004 | runtime | P0 | Task state, SQLite, pool, retry/checkpoint/wake-up | M1-04…06, M1-08 | FEAT-003 |
| FEAT-005 | collaboration | P0 | Outbox, inbox, direct communication and human actions | M1-07, M1-09, M1-11 | FEAT-003/004 |
| FEAT-006 | testkit | P0 | Fake clock/model, failure injection and offline AC suite | M1-10, SEC checks approved for M1 | FEAT-003, parallel with FEAT-004/005 |
| TASK-007 | collaboration | P0 | J1/J2 demo and retrospective | M1-12…13 | FEAT-004…006 |
| FEAT-008 | interop | P1 | A2A remote providers, tenancy, governance and observability | M2 family, C-03/C-04 | M1 exit |
| FEAT-009 | ops | P2 | Pluggable production hardening, HA, Postgres/air-gap docs | M3 family, X-10/C-05 | M2 exit |

The provisional IDs above are **planning labels**, not assigned todo-skills backlog IDs; redo the ID sequence using the skill's existing TODO/CHANGELOG rules when actual migration is approved.

## Example of expected todo-skills leaf shape

This is a **format example**, not a task eligible for copying into the active tree before a test runner exists.

```markdown
- [ ] **TASK-001** · P0 · high · Reconcile task durability and policy-wait semantics
  - Done when: accepted profile requirements and runtime states agree; `<approved documentation validation command>`
  - Links: Ref: docs/plans/PROJECT.md · Lane: contracts
```

The placeholder is deliberately **not executable**. The real migrated tree must use commands proven by the project scaffold and must pass todo-skills lint; no invented `pnpm test` until its package/test runner exists.

## Migration checklist

1. Resolve architectural conflicts and proposed ADRs.
2. Confirm toolchain, license, runtime, and exact test commands.
3. Review complete old TODO/CHANGELOG; preserve every existing ID and item.
4. Confirm migration of the current free-form TODO rather than overwriting it without a backup.
5. Populate `docs/plans/PROJECT.md` with approved scope and lanes.
6. Build the compact `# Active Backlog` tree (<=120 lines) for **only the first wave**.
7. Validate syntax/IDs/dependencies/Done-when command targets with the todo-skills lint and run it locally.
8. Only then enable /todo-continue, branch-per-leaf, test-first verification and /todo-report.

## No-go conditions

Do not mark plan complete if any source task is lost, test commands are fabricated, an ADR is proposed but called accepted, pre-dispatch policy waiting is treated as an already-defined task state, or an implementation milestone is marked done with documentation only.
