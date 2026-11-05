/** Tool v1 (docs/contracts/tool-v1.md). */
import type {
  JsonSchema,
  TrustedPrincipal,
  Version,
  VersionedRef,
} from './agent.js';
import type { OperationEffect } from './capability.js';

export type ToolId = string;
export type ToolStatus = 'registered' | 'active' | 'suspended' | 'revoked';

export interface ToolProvenance {
  publisher: string;
  source: string;
  digest: string;
  verified: boolean;
}

export interface ToolDescriptor {
  id: ToolId;
  version: Version;
  description: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  effect: OperationEffect;
  idempotency: 'idempotent' | 'keyed' | 'at-least-once';
  permission: string;
}

export interface ToolBinding {
  bindingId: string;
  toolId: ToolId;
  toolVersion: Version;
  providerId: string;
  providerVersion: Version;
  config: Record<string, unknown>;
  credentialRef?: string;
  default?: boolean;
}

export interface ToolRecord {
  descriptor: ToolDescriptor;
  provenance: ToolProvenance;
  bindings: ToolBinding[];
  status: ToolStatus;
  revision: number;
}

export interface ToolPin {
  toolId: ToolId;
  toolVersion: Version;
  bindingId: string;
  providerId: string;
  providerVersion: Version;
  digest: string;
}

export interface ToolProviderFeatures {
  protocol: string;
  protocolVersion: string;
  cancellation: boolean;
  idempotencyKeys: boolean;
  streaming: boolean;
}

export interface ToolInvocationContext {
  tenantId: string;
  taskId: string;
  executionId: string;
  principal: TrustedPrincipal;
  idempotencyKey?: string;
  credential?: unknown;
  deadline?: string;
  signal: AbortSignal;
}

export interface ToolProvider {
  readonly id: string;
  readonly version: Version;
  readonly features: ToolProviderFeatures;
  invoke(
    binding: ToolBinding,
    descriptor: ToolDescriptor,
    input: unknown,
    ctx: ToolInvocationContext,
  ): Promise<unknown>;
}

export interface ToolRegistry {
  register(
    descriptor: ToolDescriptor,
    bindings: ToolBinding[],
    provenance: Omit<ToolProvenance, 'digest' | 'verified'>,
    admin: TrustedPrincipal,
  ): Promise<ToolRecord>;
  activate(ref: VersionedRef, admin: TrustedPrincipal): Promise<ToolRecord>;
  suspend(ref: VersionedRef, admin: TrustedPrincipal): Promise<ToolRecord>;
  revoke(ref: VersionedRef, admin: TrustedPrincipal): Promise<ToolRecord>;
  get(ref: VersionedRef): ToolRecord | undefined;
  discover(
    query: { text?: string },
    caller: TrustedPrincipal,
  ): Promise<ToolDescriptor[]>;
}

export interface ToolExecutor {
  invoke(
    pin: ToolPin,
    input: unknown,
    ctx: ToolInvocationContext & { stepKey?: string },
  ): Promise<unknown>;
}
