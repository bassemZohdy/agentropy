# Compatibility matrix

**Status:** FEAT-028.10 (2026-11-06). "Tested" means an automated test in this repository exercises it on every CI run; "checked" means static validation only. Nothing is API-stable before 1.0.

## Runtime platform

| Component | Supported | How verified |
|---|---|---|
| Node.js | 24.0 or newer (`engines`) | Tested: CI on the latest Node 24 and on the floor, 24.0.0 (`node-floor` job); development on Node 24.16 |
| TypeScript | 5.9, strict, ESM (`NodeNext`) | Tested: `tsc -b` in CI |
| Package manager | pnpm 10.34 | Tested: CI and the image build |
| Operating system | Linux (container image `node:26-bookworm-slim`) | Tested: CI runner and container smoke test |

## Stores

| Store | Version | Durability | Workers | How verified |
|---|---|---|---|---|
| `MemoryStore` | — | none | 1 | Tested: Store conformance |
| `SqliteStore` (`node:sqlite`) | SQLite bundled with Node | durable-execution | several processes on one host (one writer at a time) | Tested: conformance, crash mid-transaction, three worker processes |
| `PostgresStore` | PostgreSQL 17 server via node-postgres 8.23; PostgreSQL 18.6 via PGlite 0.5.10; other servers supporting `SERIALIZABLE`, advisory locks and `COLLATE "C"` are expected to work | durable-execution | many | Tested: Store conformance, contention and benchmarks on a PostgreSQL 17 server in CI (`postgres` job) and locally; PGlite in the offline suite. Throughput grows with workers since FEAT-032.3 and FEAT-032.5 ([server benchmarks](review/2026-11-06-postgres-server-benchmarks.md)) |

## Protocols and providers

| Integration | Version | How verified |
|---|---|---|
| A2A | 1.0, JSON-RPC binding, `A2A-Version: 1.0` header; agent cards; SSE streaming (`SendStreamingMessage`, `SubscribeToTask`); push notifications (server, durable configs with sealed secrets); `ListTasks`, task continuation, file and data parts; HTTP binding | Tested: provider and server conformance (unary and streaming), two-runtime delegation and streaming, polling fallback, push-notification configs and webhook delivery, federation, the HTTP binding over sockets and in the container image, and interoperability with the reference JavaScript SDK `@a2a-js/sdk` 1.3.0 in both directions (offline), and with the reference Python SDK `a2a-sdk` 1.3.0 in both directions over loopback HTTP (opt-in: `AGENTROPY_A2A_PY=auto`, its own CI job). Other third-party implementations are not tested |
| MCP tools | MCP 2025-06-18 over Streamable HTTP (`tools/list`, `tools/call`) | Tested against a fake MCP server: discovery, calls under the executor, schema-drift refusal, SSE and session handling; no live MCP server, no stdio |
| Model API | OpenAI-compatible `POST /chat/completions` with tools | Tested against recorded fixtures; an opt-in live suite (`AGENTROPY_LLM_BASE_URL`, `AGENTROPY_LLM_MODEL`, `AGENTROPY_LLM_API_KEY`) passes against a local Ollama server (`qwen2.5:0.5b`: completion, usage, tool offer); not run against a hosted provider, and not in CI |
| OpenTelemetry | `@opentelemetry/api` 1.9; SDK 2.0 (traces, metrics) | Tested: span and metric export to in-memory exporters |
| Conductor | REST API (`/api/workflow`), Conductor OSS and Orkes | Tested against an in-process fake of the REST API; an opt-in live suite (`AGENTROPY_CONDUCTOR_URL`, `AGENTROPY_CONDUCTOR_TOKEN`) runs in CI against Conductor OSS 3.15.0 standalone. That server does not enforce the start request's idempotency key and its correlation search found nothing for a started run, so the runtime journals `workflow.start` by step key |
| Custom brokers | any request/response transport | Tested: broker sample through the communication conformance suite |
| Agent Skills | `SKILL.md` folders with YAML frontmatter | Tested: skill loader suite |

## Deployment

| Target | Version | How verified |
|---|---|---|
| Container image | OCI, non-root UID 1001, group 0 | Tested: CI builds it and runs it read-only, without capabilities, as UID 1001 and as an arbitrary UID |
| Kubernetes | `apps/v1`, `networking.k8s.io/v1`, Pod Security "restricted" | Checked: `scripts/check-deploy.mjs`; applied to a live kind cluster in CI (`deploy/kind-smoke.sh`: readiness, A2A through the Service, rolling restart, pod loss) |
| OpenShift | 4.x with `restricted-v2` SCC | Checked as above; arbitrary-UID behaviour tested in the container smoke test; not run on an OpenShift cluster |
| Air-gapped | offline install from mirrored image and pnpm store | Documented ([deployment guide](deployment.md)); the test suite runs with the network blocked |

## Contracts

| Contract | Revision |
|---|---|
| [Agent v1](contracts/agent-v1.md) | 11 |
| [Capability v1](contracts/capability-v1.md) | 13 |
| [Communication v1](contracts/communication-v1.md) | 7 |
| [Security v1](contracts/security-v1.md) | 8 |
| [Tool v1](contracts/tool-v1.md) | 3 |
| [Skill v1](contracts/skill-v1.md) | 1 |
| [Errors v1](contracts/errors-v1.md) | 2 |
| [Agent Implementation v1](contracts/agent-implementation-v1.md) | 1 |
| [Observability v1](contracts/observability-v1.md) | 5 |
| [Runtime contract](runtime-contract.md) | 5 |
| [Messaging contract](messaging-contract.md) | 4 |

Store schema version 1 (`SqliteStore`) and 2 (`PostgresStore`, commit-ordered `seq`, FEAT-032.3), each with additive evolution (new collections and index fields are created and backfilled on start); a database written by a newer release is refused ([ADR-0029](adr/0029-upgrades-and-version-migration.md)).
