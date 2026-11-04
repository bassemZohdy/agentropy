# M0 Security trust-boundary blueprint

- Date: 2026-11-04
- Status: Design baseline accepted for M0; implementation proof and negative-case tests pending
- Related: [ADR-0021](../adr/0021-delegated-authorization.md), [ADR-0022](../adr/0022-security-audit-governance.md), [runtime contract](../runtime-contract.md), [AC-09](../poc-scope.md)

## Trust domains and authoritative inputs

| Boundary | Trusted authority | Untrusted input | Required checks |
|---|---|---|---|
| User/API → AgentService | Authenticated session/token validated by host/identity adapter | User/client-provided actor, tenant, task IDs | Verified principal and tenant, request schema, permission, resource visibility |
| Agent handler → CapabilityAccess | Runtime-issued scoped execution context | Handler/LLM-provided target, arguments and metadata | Capability binding, effective grant, budget, tool/target permission, step key |
| TaskService → Internal Communication | Framework authority and pinned accepted task/route | Agent message envelope claims | PEP before dispatch, delegated scope attenuation, idempotency and replay |
| A2A/custom ingress → TaskService | Adapter-authenticated remote workload/principal under configured federation trust | Remote actor/tenant headers, A2A metadata, tracing/baggage | Verify identity/audience/trust, tenant, target permission, grant proof, replay bounds; default deny |
| Runtime → CredentialProvider | Authorized runtime/workload identity | Opaque credential reference and provider-specific metadata | Tenant ownership, resource-specific grant, just-in-time resolution, expiry/revocation |
| Task/Execution → Store / Outbox / Audit | Authoritative store transaction and audit-intent writer | External callback/replayed message | CAS, epoch fencing, idempotency, durable audit intent, no secret persistence |
| Audit/Inbox/Registry → Readers | Independent trusted PEP/PDP | Caller-supplied filters, search indices, pagination cursors | Object-level tenant and user policy at query and storage layer, no existence leakage |
| OpenTelemetry carriers → Observability | Validated transport carrier as diagnostic metadata only | traceparent/tracestate/baggage | Validate/sanitize, never authenticate or authorize from trace data |

## Delegation and authority chain

- Record authenticated initiating principal, agent workload identity, tenant, parent/child task chain, requested capability, authorized target and bounded delegated grant reference.
- Every child authorization must be narrower than or equal to effective parent authority; ambient service credentials cannot silently expand user/task privileges.
- Refresh/reissue grants independently from task snapshot. Revocations and policy changes apply at sensitive operation boundaries, including after wake-up and replay.
- Never store access/refresh tokens in checkpoints, inbox, messages, audit, logs or trace carriers; store only approved opaque references.
- Cross-tenant/A2A is **deny by default** and must have explicitly configured trust federation and approvals.

## POC checks required by accepted design

- AC-09 identity forging, tenant mismatch, expiry and unauthenticated cases remain the existing signed-off check.
- Candidate SEC-01…SEC-07 in the POC scope are **not yet M1 exit gates**; separate explicit approval is needed to expand the walking skeleton.
- Any protected state change must durably persist mandatory audit intent before it is reported committed.
- A policy-unavailable result must prevent a protected external side effect; continuation of the durable task is not the same as authorized execution.
- Negative tests for wrong-owner lookup and direct/remote actor spoofing should run with fake identity/policy providers and network disabled in M1.

## Explicit unresolved lifecycle item

The current authoritative state machine supports `running → waiting` (T4) with atomic checkpoint/wake-up; it does **not** define `created/assigned → waiting`. For a PDP outage or expired grant before a queued task's handler begins, preserve the durable accepted record and *do not* attempt a protected execution, but **do not invent a transition**. **Decision:** [ADR-0024](../adr/0024-pre-dispatch-authorization-gate.md) accepts a durable activation eligibility gate, retaining `created` / `assigned` without creating an execution lease. Exact fairness, retry and wake-up settings remain for implementation/conformance.

This is a real design gap and blocks final M0-05 signoff. Finalize before declaring a complete lifecycle contract, not by editing ADR prose alone.

## Verification gate

Architecture security direction and pre-dispatch gate are accepted for M0-05. AC-09 and candidate SEC tests document verification intent; actual passing conformance is still outstanding. No application code is authorized by this note.
