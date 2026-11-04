# ADR-0014: Isolated application contexts and provider conformance tests

- Status: Proposed (2026-11-04)
- Inspiration: [langgraph-flows ADR-0011](https://github.com/bassemZohdy/langgraph-flows/blob/main/docs/adr/ADR-0011-per-app-factory-and-config.md) and [ADR-0018](https://github.com/bassemZohdy/langgraph-flows/blob/main/docs/adr/ADR-0018-author-test-contract-and-ci.md).

## Context
An extensible framework may be embedded by multiple applications in one process or deployed with separate workers. Import-time global clients and paid-model-only tests reduce isolation and repeatability.

## Proposal
Provide per-app context/factory, explicitly scoped registry, store, runtime, models and providers; avoid mutable import-time shared instances. Support external configuration with documented precedence and secret references not stored in definitions. Publish a reusable provider/capability contract-test kit using fake deterministic providers and failure injection, runnable offline.

## Consequences
Multi-instance isolation tests and offline acceptance become design gates. Specific framework language, CLI and config file format remain open.

## Alternatives
Shared mutable module singletons, always-online integration testing and per-project incompatible test harnesses.
