# Agentropy Security Contract v1 — revision 12 (PEP/PDP, audit, credentials)

**Status:** Accepted for M1 implementation (2026-11-05). Implements the M1 subset of [ADR-0021](../adr/0021-delegated-authorization.md), [ADR-0024](../adr/0024-pre-dispatch-authorization-gate.md) and [ADR-0025](../adr/0025-security-infrastructure-errors.md). Policy engines, identity providers, credential backends and audit storage remain deferred (D-17…D-22). **Errors:** [Errors v1](errors-v1.md).

## Revision history

| Rev | Date | Change |
|---|---|---|
| 1 | 2026-11-05 | Minimal `PolicyDecisionPoint`, PEP evaluation order, `AuditIntentWriter` and `CredentialProvider` shapes for M1 |
| 2 | 2026-11-05 | Implementation (FEAT-022.2): dispatch gate and its policy actions, in-transaction audit intents with an at-least-once forwarder, grant re-validation at every protected effect (see "M1 implementation") |
| 3 | 2026-11-05 | TASK-026.3 (D-17, D-21): credential failure semantics (`AuthorityExpired`, `kind: credential`) and just-in-time resolution; per-tenant audit hash chain; `AuditService` read/verify with `audit:read` / `audit:verify` |
| 4 | 2026-11-05 | TASK-026.3 (D-15, D-18, D-19, D-20): grant narrowing for child tasks, one PEP for every ingress path, policy decision cache rules, revocation checkpoint for running work |
| 5 | 2026-11-05 | FEAT-027.7: identity-flow [threat model](../security/threat-model.md) (STRIDE per flow, each mitigation tied to a test, checked by the readiness script) and per-tenant quotas (`QuotaExceeded`) |
| 6 | 2026-11-06 | FEAT-028.2: `maxConcurrentExecutions` tenant quota, enforced across every worker sharing the store |
| 7 | 2026-11-06 | FEAT-028.4 (D-21, D-22): audit lifecycle — retention with a deployment floor, legal holds, prefix disposal with receipts, external anchors, export, audit of audit access |
| 8 | 2026-11-06 | FEAT-033.1 (R-05): a shared decision cache applies invalidations recorded in the store by any worker within `syncMs`; `revokeAuthority` records one with its audit event |
| 9 | 2026-11-14 | FIX-057 (review N-09): instance lifecycle is governed like `agent:upgrade`: `AgentService.createInstance`, `suspendInstance`, `resumeInstance`, `retireInstance`, `drainInstance` and `shareInstance` run the grant check and a policy decision (`agent:create`, `agent:suspend`, `agent:resume`, `agent:retire`, `agent:drain`, `agent:share`) before anything changes, and commit an audit intent (`instance.create`, `instance.suspend`, `instance.resume`, `instance.retire`, `instance.drain`, `instance.share`; decision `allow`) in the same transaction, so a denied call changes nothing and an allowed one is never unaudited. Creating an instance for another owner is for trusted services only |
| 10 | 2026-11-14 | TASK-067 (review N-19): audit lifecycle work no longer loads a tenant's whole chain in one transaction: the chain head keeps the chain position (`anchor` reads the head, not the log), `verify` and `exportLog` read the chain in pages of `pageSize` rows (default 500), one transaction each, and `dispose` removes at most `maxRows` rows per call (default 1000), oldest first, with a receipt each, so a long prefix is disposed by repeating the call until it returns nothing. Verification, anchors and receipts behave as before |
| 11 | 2026-11-14 | FIX-079: `verify` and `exportLog` read the chain in separate transactions (revision 10), so a `dispose` that commits between two pages removed rows past the reader's cursor and the next page linked to a row the reader never saw, which read as a broken chain; both now read again (at most twice) when the newest disposal receipt changed while they ran, so a disposal never makes a sound chain look tampered with |
| 12 | 2026-11-20 | FIX-082: revision 11 gave up after the second re-read and returned the last result unchecked, so a retention job that kept disposing (each call removes up to `maxRows`, 1000 by default, more than a 500-row page) made `verify` return and record `audit.verify` with `ok: false`, and `exportLog` return a bundle with a gap. Neither reads again now: every page transaction also reads the receipts committed since the previous page, which must chain on from the ones already read (`receipt-chain` otherwise) while the oldest row left must link to the newest (`brokenAt` that row otherwise); when the newest ends past the rows read so far, the read goes on from that receipt, as one started after the disposal would. Rows read and then disposed count as `disposed`, not in `count`, and an anchor at a position disposed meanwhile is checked against the receipts, never reported `truncated`. `exportLog` drops the rows it already holds that were disposed meanwhile and starts its bundle at the newest receipt it read. A read is never abandoned, so no disposal, however frequent, makes a sound chain look tampered with, and no retry error exists for it. A receipt read during the read is checked against the rows already read: one that ends at a row the reader has checked must name that row's hash as its `lastHash` (`receipt-chain` otherwise), and the oldest row left must be the row right after the newest receipt: the one the reader checked at that position, or the next one it reads (`brokenAt` that row otherwise), as a fresh read would report the chain broken. These checks catch a receipt read mid-read that understates or overstates a disposal, or a row relinked to it; a writer who replaces whole rows so that they chain again is reported by a fresh read or an anchor, not necessarily by the read in flight. `exportLog` runs its pages through the same checks and moves its start only on receipts that pass them; when they fail it records `audit.export` with `ok: false` and `brokenAt` and throws `InvalidState` (`details.brokenAt`, `details.reason`), instead of returning a bundle that dropped rows still in the log. A row broken at rest does not stop an export: the bundle carries it and `verifyAuditChain` reports it offline. To check this, a read keeps the hashes of at most the last `checkWindow` rows it has read since the newest receipt it read (an `AuditService` option, default 100 000), so its memory stays bounded however long the log; a receipt that ends at a row read longer ago than that cannot be compared, and the read fails with a retryable `StaleRevision` (`details.reason: checkWindow`) and records nothing, neither a sound nor a broken result |

## TypeScript contract (normative)

```ts
export interface PolicyRequest {
  principal: TrustedPrincipal;                 // from the trusted ingress, never from message content
  action: string;                              // e.g. "delegation:delegate", "tool:finance.payout:call"
  resource: { type: string; id: string; tenantId: string };
  context?: Record<string, unknown>;           // redacted attributes only
}

export type PolicyDecision =
  | { effect: "allow"; policyVersion?: string }
  | { effect: "deny"; reason?: string; policyVersion?: string };

export interface PolicyDecisionPoint {
  /** Throwing, timing out or returning anything else is "unavailable" and fails closed. */
  decide(request: PolicyRequest, signal?: AbortSignal): Promise<PolicyDecision>;
}

export interface AuditEvent {
  type: string;                                // e.g. "tool.invoke", "tool.activate", "skill.register"
  tenantId: string;
  principalId: string;
  action: string;
  resource: { type: string; id: string };
  decision: "allow" | "deny" | "error";
  correlationId?: string;
  taskId?: string;
  details?: Record<string, unknown>;           // redacted; never secrets or payloads
  at: string;
}

export interface AuditIntentWriter {
  /** Must durably commit before the protected change is reported committed. Failure → AuditCommitUnavailable. */
  record(event: AuditEvent): Promise<void>;
}

export interface CredentialProvider {
  /** Just-in-time resolution of an opaque, tenant-scoped reference. Never cached in snapshots. */
  resolve(ref: string, ctx: { tenantId: string; principal: TrustedPrincipal; purpose: string }): Promise<unknown>;
}
```

## Policy enforcement point (PEP) order

Every protected operation evaluates, before any state change or effect:

1. Trusted principal present → else `Unauthenticated`.
2. `principal.tenantId === resource.tenantId` → else `TenantMismatch` (no PDP call).
3. PDP decision: `allow` → continue; `deny` → `PermissionDenied`; throw/timeout/unknown shape → `PolicyDecisionUnavailable` (fail closed, ADR-0025).
4. Durable audit intent for state-changing or external operations: write failure → `AuditCommitUnavailable`; the operation is not dispatched or reported committed.

Denials are audited on a best-effort basis; a failed denial audit never turns a denial into an allow. Allow decisions are never reused across protected operations (no stale Allow, SEC-02).

## Redaction

`AgentropyError.message`, audit `details`, snapshots and logs never contain credentials, bearer tokens or tool payloads. Credential values exist only inside the `ToolInvocationContext` of one invocation.

## Conformance checks (M1 subset)

Unauthenticated, tenant mismatch, deny, PDP throw, PDP timeout, malformed decision → each typed; audit failure prevents the protected operation; fresh decision per invocation; secrets absent from snapshots and serialized errors (SEC-02/03/04, AC-09).

## M1 implementation (FEAT-022.2)

Verified by `packages/testkit/test/security.test.ts` (SEC-01, SEC-02, SEC-03, SEC-04, AC-09).

- **Dispatch gate (ADR-0024).** Before every lease the runtime re-checks the task's grant and asks the PDP for `task:dispatch` on the target instance, as the delegating caller, with a timeout (default 5 s). Outcomes map to gate reasons: unavailable, timed out or malformed → `policy-indeterminate` (bounded backoff: 1 s doubling to 5 min, 8 evaluations, then `nextCheckAt: null` for an operator); `deny` → `policy-denied`; expired/revoked grant → `authority-expired`/`authority-revoked`. All but the first wait for `AgentService`-level reauthorization (`delegation:reauthorize`), which records a new grant and schedules a fresh decision; it never dispatches by itself. The gate row lives in the `gates` collection; gate writes and leases are CAS-fenced on task and gate revisions, so a stale decision cannot lease. The gate never changes task status or revision and emits no `TaskEvent`.
- **Protected effects during execution.** Every non-read capability operation re-validates the delegated grant before its PDP check. A refusal with `AuthorityExpired` or `PolicyDecisionUnavailable` returns the task to `assigned` behind the gate (runtime contract T6 gate case); committed effects stay committed and journaled steps are not repeated on resume.
- **Audit intent.** Delegation acceptance, cancel, human decisions, reauthorization and every gate decision write an intent row in the same Store transaction as the change (`audit` collection, details redacted). A failed intent write aborts the transaction with `AuditCommitUnavailable`. `AuditForwarder` delivers committed intents to the `AuditIntentWriter` sink in order, at least once, adding a stable `details.auditId` for deduplication.

## M2 additions (TASK-026.3)

Verified by `packages/testkit/test/authorization.test.ts` (SEC-06, SEC-05 M2 part).

- **Credentials (D-17).** `CredentialProvider.resolve(ref, { tenantId, principal, purpose })` is called for every protected invocation that needs a credential; results are never cached by the runtime or stored. A provider signals a missing, expired, rotated-away or revoked credential by throwing `AgentropyError('AuthorityExpired', …, { details: { kind: 'credential', status } })`; any other failure is `ProviderUnavailable`. The task returns to `assigned` behind the dispatch gate (runtime contract T6 gate case) and resumes only after `reauthorize`. Journaled and keyed steps already done are not repeated.
- **Audit integrity and access (D-21).** Each audit intent row stores `prevHash` and `hash = digest(prevHash, auditId, event)`, chained per tenant inside the writing transaction. `AuditService.query` and `verify` need the independent permissions `audit:read` and `audit:verify`; another tenant's log is `NotFound`. `verify` reports the first altered or orphaned row. Retention, legal hold and external anchoring: see *Audit lifecycle* below (rev 7).
- **Grant narrowing and agent identity (D-15).** An agent delegates as itself (`type: agent`, `id` = its instance). When `GrantVerifier.narrow(ref, { tenantId, agentInstanceId, parentTaskId })` exists, the child task stores the narrowed grant; if narrowing fails the delegation is `PermissionDenied`, never accepted under the wider grant. The `task.accept` audit event records `callerType`, `parentTaskId` and `narrowed`.
- **PEP parity (D-18).** `AgentService.delegate`, the activation ingress and the built-in `delegation.delegate` operation run the same checks in the same order (authenticate, grant, tenant/visibility, `delegation:delegate` policy). The A2A provider must reuse them (FEAT-027.8).
- **Decision cache (D-19).** `CachingPolicyDecisionPoint` caches `allow` (optionally `deny`) per tenant, principal, principal type, grant, action and resource for at most `ttlMs` (default 30 s); requests with `context` are not cached; failures and malformed decisions are never cached; a changed `policyVersion` or `invalidate({ tenantId, principalId, grantRef })` drops entries immediately. Grant status is never cached. With `shared: { store, syncMs }` (FEAT-033.1) the cache also applies invalidations any worker recorded in the store (`recordPolicyInvalidation`; `revokeAuthority` records one in the transaction of its audit event) before serving a hit, reading at most every `syncMs` (default 1 s): a revocation reaches every worker within `syncMs`. If that read fails, the cache drops every entry and asks the PDP. Stored invalidations keep the grant reference's digest, never the reference, and are pruned after 10 min; a shared cache's `ttlMs` may not exceed that.
- **Revocation checkpoint (D-20).** `revokeAuthority(grantRef)` (trusted services) aborts running executions under that grant with `AuthorityExpired` (status `revoked`), invalidates cached decisions and audits the revocation with the grant's digest only. Queued work is held by the dispatch gate. Committed effects are not rolled back; `listEffects(taskId)` returns the journal for an authorized compensation decided by the application.
- **Tenant quotas (M2-11).** `createLocalApp({ quotas: (tenantId) => ({ maxActiveTasks?, maxAcceptsPerMinute?, maxInstances?, maxConcurrentExecutions? }) })`. Checked inside the accepting (or instance-creating) transaction, after idempotent replays are answered; a refusal is `QuotaExceeded` (retryable) with only the quota name and limit in its details, and never affects another tenant. `maxConcurrentExecutions` (M3-02) is not a refusal: it is counted inside each lease transaction over the running executions of every worker sharing the store, and excess work stays queued.
- **Audit lifecycle (D-22, rev 7).** `AuditService` actions are separate permissions: `audit:read`, `audit:verify`, `audit:export`, `audit:retention`, `audit:hold`, `audit:release-hold`, `audit:anchor`, `audit:dispose`; each use and each policy denial writes an `audit.*` event (after the operation, so reads do not recurse). Retention: deployment `auditRetention = { defaultDays, floorDays, perType? }` (default 365/30); `setRetention` lets a tenant lengthen but never go below the floor (`SchemaViolation`, `reason: belowFloor`). `dispose` removes only the oldest contiguous run of rows that are expired, already forwarded to the audit sink and not matched by an active hold (`placeHold` by types and time range; `releaseHold` returns rows to retention and deletes nothing), and stores a receipt with positions, boundary hashes and counts per type — no payloads — so `verify` links the rest of the chain to genesis. A call disposes at most `maxRows` rows (revision 10); repeat it until it returns `undefined`. `anchor` publishes `{ position, auditId, hash }` to `auditAnchors` (an independently protected sink); `verify(tenantId, caller, { anchors })` reports `anchor-mismatch` or `truncated`. `exportLog` returns rows with links, checked offline by `verifyAuditChain(rows, startHash)`. `verify` and `exportLog` read in pages, one transaction each, and may run while disposals commit (revision 12): each page comes with the receipts committed since the last one, and the read goes on from the newest receipt when it removed rows not yet read, so a concurrent disposal never yields a broken result or a bundle with a gap. A receipt read mid-read must chain on from the ones read before, name the hash of the row at its `toPosition` when the reader has checked that row, and the oldest row left must link to it and be the row right after it; otherwise `verify` reports the chain broken and `exportLog` throws `InvalidState` (`details.brokenAt`, `details.reason`). A receipt that ends further behind the reader than the `checkWindow` rows it keeps (default 100 000) fails the read with a retryable `StaleRevision`; read again. Concrete retention values, storage and signing remain deployment decisions.
- **Threat model.** [docs/security/threat-model.md](../security/threat-model.md) lists STRIDE threats per identity flow with the mitigating test; planned rows name their owning backlog item.
