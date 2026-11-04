# ADR-0021: Delegated authorization and independent agent identity

- Status: Accepted (architecture direction); identity/token mechanisms deferred
- Date: 2026-11-04
- Scope: Documentation and security architecture only; no implementation or milestone start authorized.

## Context

Agents may invoke other agents, tools, workflow providers and external systems on a user's behalf, including after a user session ends. Agentropy must preserve least privilege, tenant isolation, traceable delegation chains and runtime policy enforcement across internal and A2A communication without depending on a particular identity provider.

## Decision

1. **Distinct identities:** Every invoking agent has an independently verifiable workload/agent identity, separate from the initiating user's principal. A message actor claim by itself is never authentication.
2. **Explicit bounded delegation:** Delegate only the authorities necessary for a particular task, target, capability, tenant and permitted lifetime. Each child delegation must be equal to or narrower than its parent's effective grant and must be rejected if it attempts privilege escalation.
3. **Authorization checkpoints:** Enforce policies on task acceptance/delegation and again before sensitive operations (tool invocation, data access, external side effects, capability use, human-action decision and cross-trust communication). A task's pinned configuration is **not** an irrevocable authorization grant.
4. **Complete audit chain:** Record the initiating principal, acting agent identity, delegated authority provenance, parent/child tasks, target capability and allow/deny decisions, with appropriate redaction. Audit identifiers and business correlation remain independent of trace IDs.
5. **Live revocation and expiry:** Authorization checks must honor current revocation, expiration, tenant status and policy changes. On denial, prevent new sensitive side effects and place work into an explicit waiting/blocked/failed disposition according to the task lifecycle; do not assume every in-flight external operation can be rolled back.
6. **No implicit impersonation:** Delegation is the default. Impersonation is denied unless a separately authorized, time-bounded and auditable exception policy explicitly permits it.
7. **Provider-neutral governance:** Core governance defines common authorization decisions and enforcement hooks; identity, policy evaluation and credentials come from pluggable trusted providers. Never rely on the transport (internal, A2A, broker) to make an unauthenticated grant trustworthy.
8. **Cross-tenant and cross-boundary:** Enforce tenant isolation by default. Cross-tenant calls require explicit authorization and trusted delegation exchange; never forward raw user tokens or trust unverified envelope fields merely because an A2A endpoint accepted a message.
9. **Credential separation:** Store secrets and refresh credentials outside ordinary task state, messages, logs and traces. Pass only scoped references/capabilities where safe; apply expiry and rotation policies.

## Boundaries and deferred implementation decisions

- Select identity/token exchange standards and specific Keycloak or other IdP flows separately after threat modeling. This ADR does **not** claim that RFC 8693 token exchange or any specific Keycloak feature is available in the target environment.
- Determine secure remote delegation proofs, trust federation, service-to-service authentication, revocation propagation and credential refresh mechanisms during implementation design.
- The precise policy decision point (PDP) and policy enforcement point (PEP) interfaces and error types require contract work.
- Existing ADR-0009 remains proposed for its unresolved mechanism-level details; this ADR records the accepted general security direction.

## Acceptance expectations

- Spoofed actor claims, privilege-widening delegation, wrong-tenant access and expired/revoked grants fail closed.
- A long-running task that resumes after a permission is revoked cannot carry out new protected actions using an earlier authorization snapshot.
- Audit includes the chain user → agent → delegated agent without embedding bearer tokens.
- Both internal and A2A adapters are subject to equivalent effective authorization policy (adapted to their trust boundary and enforcement capabilities).

## Related

[ADR-0009](0009-authorization-and-governance.md), [ADR-0019](0019-operational-and-communication-decisions.md), [ADR-0020](0020-opentelemetry-observability.md), [Requirements](../requirements.md).
