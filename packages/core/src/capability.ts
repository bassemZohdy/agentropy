/** Capability v1 revision 6 types (docs/contracts/capability-v1.md). */
import type { JsonSchema } from './agent.js';

export type CapabilityId = string;
export type CapabilityVersion = string;
export type OperationEffect = 'read' | 'internal' | 'external';

export interface OperationContract {
  name: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  permission: string;
  effect: OperationEffect;
}

export interface CapabilityRequirement {
  id: CapabilityId;
  versionRange: string;
}

export interface CapabilityContract {
  id: CapabilityId;
  version: CapabilityVersion;
  kind: 'behavior' | 'guarantee';
  configSchema: JsonSchema;
  dependencies: CapabilityRequirement[];
  conflicts?: CapabilityRequirement[];
  operations: OperationContract[];
  levels?: string[];
}

export interface CapabilitySelection {
  id: CapabilityId;
  versionRange: string;
  config?: Record<string, unknown>;
  providerId?: string;
  level?: string;
  remove?: boolean;
}

export interface CapabilityBinding {
  id: CapabilityId;
  version: CapabilityVersion;
  providerId: string;
  providerVersion: string;
  config: Record<string, unknown>;
  level?: string;
}

export interface AgentProfile {
  id: string;
  version: string;
  required: CapabilitySelection[];
  defaults: CapabilitySelection[];
  optional: CapabilityRequirement[];
}

export interface RuntimeRequirements {
  guarantees: CapabilitySelection[];
}

export interface EffectiveCapabilitySnapshot {
  snapshotId: string;
  bindings: CapabilityBinding[];
  policyRef: { id: string; version: string };
  resolvedAt: string;
}

export interface CapabilityInvocationContext {
  tenantId: string;
  taskId: string;
  executionId: string;
  principalId: string;
  delegatedAuthorityRef?: string;
  idempotencyKey?: string;
  /** The handler's step key for this effect, when it gave one (the idempotency key is derived from it). */
  stepKey?: string;
  /** W3C traceparent of the capability span, for propagating trace context to child work (never authorization). */
  traceparent?: string;
  signal: AbortSignal;
}

export interface CapabilityProvider {
  readonly id: string;
  readonly version: string;
  readonly contracts: {
    id: CapabilityId;
    version: CapabilityVersion;
    level?: string;
  }[];
  invoke<I, O>(
    operation: string,
    input: I,
    context: CapabilityInvocationContext,
  ): Promise<O>;
}

export interface CapabilityAccess {
  invoke<I, O>(
    capabilityId: CapabilityId,
    operation: string,
    input: I,
    options?: { stepKey?: string },
  ): Promise<O>;
}
