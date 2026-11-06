# ADR-0022: Security audit access, retention, legal hold and integrity

- Status: Accepted (architecture direction, 2026-11-04); mechanisms implemented by FEAT-028.4 ([Security v1](../contracts/security-v1.md) rev 7, 2026-11-06); concrete retention values, storage, signing and dual control remain deployment decisions
- Scope: Agentropy design/documentation only; no implementation authorized

## Context

[ADR-0021](0021-delegated-authorization.md) establishes an independent, mandatory and reliable Security Audit Trail, separate from sampled OpenTelemetry telemetry. This decision completes the audit access and lifecycle policy without prescribing a standalone audit service or specific storage technology.

## Accepted decisions

1. **Independent permissions and separation of duties.** Audit read/search, export, retention management, legal-hold management, integrity verification and disposal are distinct authorization actions. Creating an event does not confer read rights. Security administrators are not automatically unrestricted audit readers. Sensitive administrative changes require explicit governance authorization; separation of duties and dual approval are configurable and can be mandatory under organization policy.
2. **Tenant isolation.** Queries, exports, verification, archive and disposal are tenant-scoped at the enforcement point and storage boundary. Cross-tenant access requires explicit exceptional policy, a documented purpose and an independently audited decision, never a wildcard inherited from an agent identity.
3. **Audit the auditors.** Protected audit reads, access denials, exports, changes in policy/hold, disposal requests, and integrity-verification outcomes generate their own canonical, redacted audit events. Prevent unbounded recursion by recording audit-access metadata without auditing the internal write of that event as another external read.
4. **Configurable retention with enforceable floors.** Retention, archive tier, encryption, access rules and export targets may be configured per deployment/tenant/event category; lower-trust scopes cannot shorten mandatory minimums established by trusted governance. Define a documented default before launch. Do not hard-code a universal legal duration.
5. **Legal hold.** An authorized legal/investigation hold suspends ordinary deletion or expiration for matching records and their necessary integrity evidence. Hold creation, extension and release are independently authorized and auditable. Release returns data to the applicable retention policy; it is not an instant irreversible purge.
6. **Controlled archival and disposal.** On expiration without hold, archival or deletion follows authorized, recorded lifecycle rules. Maintain minimal non-sensitive disposal receipts and integrity anchoring evidence where policy permits. Record which data was removed and by whose authorization without retaining the prohibited original payload.
7. **Tamper evidence and verification.** Support verifiable append-only integrity with a suitable trust anchor (for example hash chaining plus independently protected checkpoints, or WORM/immutable backend). Hashing without a separately protected anchor cannot establish resistance to deletion or wholesale rewriting. Verify integrity on a configurable schedule and after restore, migration and archival; alert and preserve evidence on discrepancy.
8. **Reliability and privacy.** Critical audit intent is durably committed before reporting the protected change as committed, atomically or through a transactional outbox when feasible; remote sink lag must be visible. Limit stored sensitive fields, encrypt in transit/at rest, apply narrowly authorized access and lawful disposal. Audit history is not a license to retain unnecessary secrets or personal data forever.
9. **Vendor neutrality.** Audit storage, archival, signing/anchoring and export remain provider abstractions. Concrete provider, regulatory retention values and jurisdiction rules are deployment decisions.

## Acceptance criteria for future contract/tests

- User/agent without audit-read authorization cannot enumerate or infer another tenant's events.
- Audit access and export actions are recorded; privileged role alone does not bypass policy.
- A hold blocks scheduled/manual disposal, including archived records, until an authorized release.
- Manipulating or omitting stored records is detected by verification against a protected integrity anchor.
- Inaccessible audit persistence prevents a new protected state change from reporting committed success; incomplete delivery remains observable and recoverable.
- Deletion after expiry produces a non-sensitive disposal receipt without preserving deleted confidential content.

## Deferred

Specific permissions schema, dual-control criteria, storage backend, WORM/hash scheme, signing keys, retention schedules, data-subject request handling and jurisdiction-specific rules need threat/legal review and implementation conformance.

## Related

[ADR-0021](0021-delegated-authorization.md) · [ADR-0020](0020-opentelemetry-observability.md) · [Requirements](../requirements.md).
