# 2026-11-06 — Project review: concerns and improvements

**What this is:** a sweep of the repository after FEAT-031 (M1–M3 delivered, backlog empty) for everything that is known to be missing, weak or inconsistent. Sources: the code (`packages/*/src`), the contracts and their "not implemented" notes, the [compatibility matrix](../compatibility.md), the [threat model](../security/threat-model.md), the [design follow-ups](../plans/DESIGN-FOLLOWUPS.md), the ADR index, CHANGELOG "Not included" notes, CI configuration and what this session's work ran into. Each finding has an ID (`R-nn`) and the backlog root that owns it in [TODO.md](../../TODO.md).

Severity: **high** = a production deployment would hit it; **medium** = limits a supported use or weakens a guarantee; **low** = hygiene, docs or developer experience.

## Runtime and scale

| ID | Sev | Finding | Evidence | Proposed action | Root |
|---|---|---|---|---|---|
| R-01 | high | Every writing transaction updates the store-wide `seq` counter row, so concurrent writers on one PostgreSQL database serialize; four workers were slower than one in CI (53 → 36 tasks/s) and once collapsed to 4.3 tasks/s locally | [server benchmarks](2026-11-06-postgres-server-benchmarks.md); [ADR-0028](../adr/0028-postgresql-store-adapter.md) | Revise ADR-0028: ordering that keeps "seq order = commit order" for readers without one hot row (e.g. a sequence plus a commit-visible high-water mark), then re-run the multi-worker benchmark | FEAT-032 |
| R-02 | high | An acceptance is 36 sequential statements and a completion 62; server latency is round-trip bound (≈ 36 × RTT) | server benchmarks, "Where the time goes" | Batch statements within a transaction; target ≤ 12 round trips per acceptance | FEAT-032 |
| R-03 | medium | Serialization retries are invisible: no metric or span attribute counts them, so contention cannot be seen in production | `packages/store-postgres/src/index.ts` retry loop | Count retries and exhausted retries in Observability v1 | FEAT-032 |
| R-04 | medium | PostgreSQL targets are provisional: measured only in Docker Desktop and on CI runners | [SLOs](../slo.md#postgresql) | Measure on a dedicated database host and finalize | FEAT-032 |
| R-05 | medium | `PolicyDecisionCache.invalidate` only clears the local process; with several workers a revoked grant can still be allowed elsewhere until `ttlMs` (30 s) | `packages/runtime/src/policy-cache.ts` | Propagate invalidation through the store (an invalidation epoch row read with the decision) or document a TTL bound per deployment; done in FEAT-033.1 (`shared` cache, bound `syncMs`) | FEAT-033 |
| R-06 | medium | Wake-up polling evaluates every armed registration on each poll (O(n) per tick) | `packages/runtime/src/wakeups.ts` `poll` | Due-time index queries (`dueAt <= now`) and event-driven arming; benchmark with 10k waiting tasks; done in FEAT-033.2 (`checkAt` index, 300 → 3 ms per poll at 10k) | FEAT-033 |
| R-26 | medium | Every audit intent scanned the tenant's whole audit chain to find its predecessor, so each acceptance got slower as the chain grew (O(n) per append) | `packages/runtime/src/audit.ts` `recordAuditIntent` | Keep a per-tenant chain head row; fixed in FEAT-032.2 | FEAT-032 |
| R-07 | low | `a2a.ts` (1.3k lines), `runtime.ts` (1.2k) and `task-service.ts` (1k) are the largest modules; A2A mixes server, push, client and SSE parsing | `wc -l packages/runtime/src/*.ts` | Split `a2a.ts` into server, push, client and sse modules without API change; done in TASK-031 (largest module now 450 lines) | TASK-031 |

## Interoperability

| ID | Sev | Finding | Evidence | Proposed action | Root |
|---|---|---|---|---|---|
| R-08 | high | The A2A server is a library only: the host serves `/healthz` and `/readyz`, with no HTTP/SSE binding for `handle`/`stream`, no authentication adapter and no `/.well-known/agent-card.json` | `packages/examples/src/host.ts` | Reference HTTP binding (JSON-RPC POST, SSE responses, bearer/mTLS principal mapping, agent card), wired into the host and smoke-tested in the image job | FEAT-034 |
| R-09 | medium | Never tested against a third-party A2A implementation | [compatibility](../compatibility.md) | Interop test against the reference A2A SDK (pinned), offline in CI with a recorded or containerized peer | FEAT-034 |
| R-10 | medium | A2A gaps: `ListTasks`, task continuation (`message.taskId`), file parts, push-config paging, durable push configs (lost on restart), no outbound push configuration; a deleted config's watcher holds its subscription until the next task event | `packages/runtime/src/a2a.ts` header; [Communication v1](../contracts/communication-v1.md) | Implement in that order of user value; persist push configs in the store and resume watchers on start | FEAT-034 |
| R-11 | medium | No MCP tool adapter, although MCP is the dominant tool protocol; only direct and loopback JSON-RPC tool providers exist | `packages/runtime/src/tools.ts`; [tool-protocol evaluation](2026-11-05-tool-protocol-evaluation.md) | MCP client tool provider (tools/list, tools/call) under the existing PEP and audit path | FEAT-035 |
| R-12 | medium | The model API and Conductor adapters are tested only against recorded fixtures and an in-process fake | [compatibility](../compatibility.md) | Opt-in live suites (like `AGENTROPY_PG_URL`), and a Conductor OSS service container job in CI | FEAT-035 |
| R-13 | low | Model routing was evaluated (N-03) but not implemented | [model routing evaluation](2026-11-06-model-routing-evaluation.md) | Rule-based routing wrapper with residency/data-class floors as recommended | FEAT-035 |

## Deployment, supply chain and release

| ID | Sev | Finding | Evidence | Proposed action | Root |
|---|---|---|---|---|---|
| R-14 | high | Kubernetes/OpenShift manifests are only checked statically, never applied to a cluster | [compatibility](../compatibility.md); `scripts/check-deploy.mjs` | CI job with kind: apply manifests, wait for readiness, roll, delete a pod, verify recovery | FEAT-036 |
| R-15 | medium | No dependency update automation or vulnerability audit; GitHub Actions are pinned by tag (`@v4`), not commit SHA; base image not pinned by digest in the repo | `.github/workflows/*.yml`; `deploy/Dockerfile` | Dependabot or Renovate, `pnpm audit --prod` in CI, SHA-pinned actions, digest-pinned base image | TASK-030 |
| R-16 | medium | No SBOM, image signature or npm provenance | [release](../release.md) | Generate an SBOM for packages and image; sign the image; publish with provenance when publishing starts | TASK-030 |
| R-17 | medium | Publishing decisions open: version, `@agentropy` scope ownership, release flow, image registry | [release, owner decisions](../release.md#owner-decisions) | Owner decides; then a tag-triggered release workflow | TASK-032 |

## Developer experience and quality

| ID | Sev | Finding | Evidence | Proposed action | Root |
|---|---|---|---|---|---|
| R-18 | medium | On a Windows checkout (`core.autocrlf=true`) `pnpm format:check` reports every file and `api-index.mjs --check` fails, because files are checked out with CRLF; Windows is not a supported OS but is used for development | this session | Add `.gitattributes` with `* text=auto eol=lf` and renormalize | TASK-033 |
| R-19 | low | `skills.test.ts` "symlink escapes" fails on Windows without symlink privilege (EPERM), so `pnpm check` is red locally | `packages/runtime/test/skills.test.ts` | Skip the symlink case when the OS refuses to create symlinks, keep it mandatory in CI | TASK-033 |
| R-20 | low | The offline network guard is per module instance: a test importing `@agentropy/testkit` (resolved to `dist`) gets a second guard, so `blockNetwork()()` silently does not lift the installed one | FEAT-031 workaround in `postgres-server.test.ts` | A process-global guard (symbol on `globalThis`) with an explicit `allowNetwork(hosts)` | TASK-033 |
| R-21 | low | No coverage measurement; untested branches are invisible | `vitest.config.ts` | Enable V8 coverage in CI with a recorded baseline (report only, no gate at first) | TASK-033 |
| R-22 | low | The compatibility matrix says code avoids APIs newer than Node 22.13 and development is on 22.23, while `engines` requires ≥ 24 and this session ran 24.16 | [compatibility](../compatibility.md) | Decide the floor (24 per `engines`) and correct the row; test the floor in CI | TASK-033 |

## Governance and documentation

| ID | Sev | Finding | Evidence | Proposed action | Root |
|---|---|---|---|---|---|
| R-23 | medium | Eight ADRs are still *Proposed* (0008–0014, 0018) although M1–M3 implemented most of them | `docs/adr/` | Review each: accept with evidence, supersede, or record what is still unproven | TASK-034 |
| R-24 | low | D-09 (Temporal + LangGraph TypeScript integration) is deferred with no milestone | [design follow-ups](../plans/DESIGN-FOLLOWUPS.md) | Owner decides keep-deferred or schedule | TASK-034 |
| R-25 | low | The threat model scopes the single-process runtime; multi-worker and networked-database flows (shared store credentials, cross-worker cache staleness, R-05) have no rows | [threat model](../security/threat-model.md) | Extend STRIDE to multi-worker and PostgreSQL deployment flows | TASK-034 |
