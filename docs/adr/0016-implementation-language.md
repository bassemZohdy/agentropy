# ADR-0016: Initial implementation language and tooling

- Status: Accepted (2026-11-04) — TypeScript/Node.js M1 stack; specific dependency versions and package names remain setup choices
- Resolves: roadmap M0-01

## Context

Every contract (Agent, Capability, Communication, Errors) is already written in TypeScript notation, but the language was never decided (M0-01). Implementation cannot start without it. Requirements that bear on the choice: offline deterministic tests (R-28), JSON Schema at boundaries (R-22), A2A interoperability (R-32), an embeddable library rather than a server product, and contributors who may also write agents in Python.

## Accepted M1 decision

- **TypeScript (strict) on the current Node.js Active LTS**, ESM only.
- **pnpm workspaces** monorepo with the layout in [POC scope](../poc-scope.md).
- **JSON Schema 2020-12** is the canonical schema format in contracts; a TypeScript-first validator that emits JSON Schema (e.g. TypeBox or Zod 4) is chosen at setup, with Ajv for validating stored/remote schemas.
- **Vitest** for tests; the testkit package exposes conformance suites as plain functions so provider authors can run them in their own repos.
- Lint/format: ESLint + Prettier (or Biome — one tool, chosen at setup).

## Consequences

Contracts translate directly to code; `AbortSignal`/`AsyncIterable` in the contracts are native. JS A2A SDKs and LangGraph.js exist for later providers. Python agents interoperate through A2A rather than in-process. CPU-heavy work is not a concern for a control plane.

## Alternatives

- **Java/Kotlin (Spring/Quarkus):** strong for enterprise/OpenShift deployments and Temporal/Quarkus Flow providers, but the contracts would need rewriting and the embed-as-library story is heavier.
- **Python:** best ML ecosystem and matches langgraph-flows, but weaker static typing for the contract-heavy core.
- **Go:** good runtime characteristics, weaker fit for generic, schema-driven handler contracts.

## Remaining setup choices

Package scope/name on npm; exact minimum supported Node version, concrete schema authoring library, and lint/format preference will be fixed at setup and verified with offline CI. No implementation has started. Temporal + LangGraph TypeScript integration remains explicitly deferred.
