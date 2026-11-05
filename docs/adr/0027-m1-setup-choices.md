# ADR-0027: M1 setup choices — validator, SemVer, YAML, SQLite driver, package placement

- Status: Accepted (2026-11-05)
- Resolves: the "remaining setup choices" left open by [ADR-0016](0016-implementation-language.md) and [ADR-0017](0017-first-persistence-and-activation.md). Does not change either decision.

## Context

ADR-0016 accepted TypeScript/Node.js/pnpm/Vitest/ESLint/Prettier and JSON Schema 2020-12, leaving the validator library and exact versions to setup. ADR-0017 accepted SQLite for M1 and left the driver open. The readiness closure (2026-11-05) needs these fixed before the first implementation leaves land.

## Decision

1. **Schema validation:** JSON Schema 2020-12 documents are written as plain `const` objects next to the TypeScript interfaces in `packages/core`, and validated with **Ajv** (`ajv/dist/2020`) plus `ajv-formats`. No schema-authoring DSL (TypeBox/Zod) in M1: the contracts are already TypeScript interfaces, and fixtures in tests keep the two aligned. Revisit if drift becomes a measured problem.
2. **Version ranges:** the `semver` package (npm SemVer semantics) for `versionRange` resolution in capabilities, tools, skills and profiles. Highest satisfying version wins.
3. **Skill frontmatter:** the `yaml` package parses `SKILL.md` frontmatter in `packages/runtime`. The core package performs no file I/O.
4. **SQLite driver:** the built-in `node:sqlite` module (`DatabaseSync`) — no native build step or install scripts. The `Store` port stays driver-neutral so PostgreSQL (M3-07) can implement the same conformance suite.
5. **Placement:** `core` holds types, JSON Schemas, the error catalog, transition tables, the capability catalog/profiles and the **pure** resolution functions (capability, implementation, tool, skill); `runtime` holds stateful registries, executors and services. This refines the layout comment in [POC scope](../poc-scope.md).
6. **Node.js:** `engines.node >= 24` remains; CI runs Node 24. Code must not depend on APIs newer than Node 22.13 so local verification on Node 22 stays meaningful.

## Consequences

Small, widely used dependencies; no compiled add-ons. `node:sqlite` still emits an experimental warning on some Node versions; this is accepted for M1 and re-evaluated at M3-07. Schema/type drift is caught by fixture tests rather than by construction.

## Alternatives

TypeBox or Zod 4 as single source of truth (stronger coupling, less readable public types); `better-sqlite3` (native build, pnpm build-script approval); hand-written range matching (error-prone).
