/** Security v1 (docs/contracts/security-v1.md): minimal M1 PEP/PDP/audit/credential shapes. */
import type { TrustedPrincipal } from './agent.js';

export interface PolicyRequest {
  principal: TrustedPrincipal;
  action: string;
  resource: { type: string; id: string; tenantId: string };
  context?: Record<string, unknown>;
}

export type PolicyDecision =
  | { effect: 'allow'; policyVersion?: string }
  | { effect: 'deny'; reason?: string; policyVersion?: string };

export interface PolicyDecisionPoint {
  decide(request: PolicyRequest, signal?: AbortSignal): Promise<PolicyDecision>;
}

export interface AuditEvent {
  type: string;
  tenantId: string;
  principalId: string;
  action: string;
  resource: { type: string; id: string };
  decision: 'allow' | 'deny' | 'error';
  correlationId?: string;
  taskId?: string;
  details?: Record<string, unknown>;
  at: string;
}

export interface AuditIntentWriter {
  record(event: AuditEvent): Promise<void>;
}

export interface CredentialProvider {
  resolve(
    ref: string,
    ctx: { tenantId: string; principal: TrustedPrincipal; purpose: string },
  ): Promise<unknown>;
}
