# M1 Security Acceptance — scope recommendation and decision gate

- Date: 2026-11-04
- Status: **Accepted M1 security scope** (2026-11-04); executable tests and implementation pending
- References: [POC scope](../poc-scope.md), [security closeout](../review/2026-11-04-security-governance-closeout.md), [ADR-0021](../adr/0021-delegated-authorization.md), [ADR-0024](../adr/0024-pre-dispatch-authorization-gate.md)

## Why the gate is needed

Current M1 exit is AC-01…AC-20. Accepted security design adds PDP/PEP failure, durable audit intent, runtime revocation and pre-dispatch eligibility semantics. Turning every enterprise feature into M1 would overbuild the walking skeleton; ignoring all of them would leave unsafe defaults.

## Accepted security scope split

| Candidate | M1 offline fake-provider minimum | Later depth |
|---|---|---|
| SEC-01 PDP outage | Reject/hold protected dispatch in created/assigned via durable non-lifecycle gate, restart, bounded recheck and audited safe resume | M2 availability/caching consistency, M3 HA |
| SEC-02 Revocation | Revoke grant after task acceptance, next tool/external dispatch denied; task preserved; no stale cached Allow | M2 remote propagation and in-flight cooperative cancellation |
| SEC-03 Mandatory audit | Fail audit-intent persistence and verify no protected state change committed; outbox replay and dedupe after restart | M2 independent sinks; M3 integrity/retention |
| SEC-04 Identity/transport | Forged `actor`/tenant/trace claims ignored, trusted inbound direct adapter identity and mandatory PEP checks | M2 A2A federation/cross-tenant denial |
| SEC-07 Human approval | Expired/revoked grant or stale action revision cannot authorize approval; no duplicate side effects | M2 delegated cross-provider approvals |
| SEC-05 Audit authorization/hold/integrity | **Not a full M1 gate** beyond mandatory event redaction/tenant ownership | M2 read/export control; M3 legal hold/archive integrity |
| SEC-06 Credential rotation | **Not M1** beyond proof tokens are never persisted in checkpoints/messages/audit | M2 credential provider rotation and recovery |

## Definition of done when implemented

- SEC-01/02/03/04/07 are mandatory M1 acceptance checks alongside AC-01…AC-20; assign exact executable test targets once the testkit exists.
- Tests run offline with fake identity/PDP/audit/clock and SQLite; no live Keycloak, Vault, OPA, A2A endpoint or hosted LLM.
- A claimed PASS requires actual test execution. Design acceptance alone does not pass these checks.
- Failures must use catalogued or explicitly proposed typed codes. Unknown external effects must be reconciled, not reported as rollback/exactly-once.

## Recorded decision

M1 requires offline SEC-01/02/03/04/07. SEC-05/06 full suites remain deferred to M2/M3. Their foundational tenant isolation and secret redaction still apply in M1. This is scope approval, not a claim of passing tests.
