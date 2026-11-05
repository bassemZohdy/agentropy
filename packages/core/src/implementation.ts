/** Agent Implementation v1 (docs/contracts/agent-implementation-v1.md). */
import type {
  Agent,
  AgentImplementationRef,
  Version,
  VersionedRef,
} from './agent.js';

export interface ImplementationFeatures {
  checkpointResume: boolean;
  cooperativeCancellation: boolean;
  progressReporting: boolean;
  isolation: 'in-process' | 'process' | 'sandbox';
  remoteAuthority: boolean;
}

export interface ImplementationBinding {
  providerId: string;
  providerVersion: Version;
  artifact: VersionedRef;
  artifactDigest?: string;
  features: ImplementationFeatures;
}

export interface ImplementationResolveContext {
  tenantId: string;
  signal?: AbortSignal;
}

export interface AgentImplementationProvider {
  readonly id: string;
  readonly version: Version;
  readonly features: ImplementationFeatures;
  resolve(
    ref: AgentImplementationRef,
    ctx: ImplementationResolveContext,
  ): Promise<ImplementationBinding>;
  createAgent(binding: ImplementationBinding): Agent;
}

export interface ImplementationProviderRegistry {
  register(provider: AgentImplementationProvider): void;
  get(
    providerId: string,
    providerVersion: Version,
  ): AgentImplementationProvider;
}
