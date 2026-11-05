/** Agent Implementation v1: provider registry, HandlerRegistry and the built-in native-ts provider. */
import {
  AgentropyError,
  type Agent,
  type AgentImplementationProvider,
  type AgentImplementationRef,
  type HandlerRegistry,
  type ImplementationBinding,
  type ImplementationFeatures,
  type ImplementationProviderRegistry,
  type VersionedRef,
} from '@agentropy/core';

const key = (ref: VersionedRef) => `${ref.id}@${ref.version}`;

export class InMemoryHandlerRegistry implements HandlerRegistry {
  private readonly handlers = new Map<string, Agent>();

  register(artifact: VersionedRef, handler: Agent): void {
    const existing = this.handlers.get(key(artifact));
    if (existing && existing !== handler) {
      throw new AgentropyError(
        'InvalidConfiguration',
        `Artifact ${key(artifact)} already has a different handler`,
        { details: { reason: 'immutable' } },
      );
    }
    this.handlers.set(key(artifact), handler);
  }

  unregister(artifact: VersionedRef): void {
    this.handlers.delete(key(artifact));
  }

  get(artifact: VersionedRef): Agent | undefined {
    return this.handlers.get(key(artifact));
  }
}

export const NATIVE_TS_FEATURES: ImplementationFeatures = {
  checkpointResume: true,
  cooperativeCancellation: true,
  progressReporting: true,
  isolation: 'in-process',
  remoteAuthority: false,
};

/** Built-in provider for TypeScript handlers registered in a HandlerRegistry. */
export class NativeImplementationProvider implements AgentImplementationProvider {
  readonly id = 'native-ts';
  readonly version = '1.0.0';
  readonly features = NATIVE_TS_FEATURES;

  constructor(
    readonly handlers: HandlerRegistry = new InMemoryHandlerRegistry(),
  ) {}

  async resolve(ref: AgentImplementationRef): Promise<ImplementationBinding> {
    if (ref.providerId !== this.id || ref.providerVersion !== this.version) {
      throw new AgentropyError(
        'IncompatibleVersion',
        `native-ts cannot resolve ${ref.providerId}@${ref.providerVersion}`,
        { details: { kind: 'implementation-provider' } },
      );
    }
    if (!this.handlers.get(ref.artifact)) {
      throw new AgentropyError(
        'NotFound',
        `No handler registered for ${key(ref.artifact)}`,
        { details: { kind: 'implementation-artifact' } },
      );
    }
    return {
      providerId: this.id,
      providerVersion: this.version,
      artifact: { ...ref.artifact },
      features: { ...this.features },
    };
  }

  /** The handler is looked up per activation, so an unregistered artifact fails that activation with IncompatibleVersion (AC-10). */
  createAgent(binding: ImplementationBinding): Agent {
    return {
      handle: (invocation, context) => {
        const handler = this.handlers.get(binding.artifact);
        if (!handler) {
          return Promise.reject(
            new AgentropyError(
              'IncompatibleVersion',
              `Handler for ${key(binding.artifact)} is no longer registered`,
              { details: { kind: 'implementation-artifact' } },
            ),
          );
        }
        return handler.handle(invocation, context);
      },
    };
  }
}

export class InMemoryImplementationProviderRegistry implements ImplementationProviderRegistry {
  private readonly providers = new Map<string, AgentImplementationProvider>();

  register(provider: AgentImplementationProvider): void {
    const k = `${provider.id}@${provider.version}`;
    const existing = this.providers.get(k);
    if (
      existing &&
      existing !== provider &&
      JSON.stringify(existing.features) !== JSON.stringify(provider.features)
    ) {
      throw new AgentropyError(
        'InvalidConfiguration',
        `Implementation provider ${k} already registered with different features`,
        { details: { reason: 'immutable' } },
      );
    }
    this.providers.set(k, provider);
  }

  find(
    providerId: string,
    providerVersion: string,
  ): AgentImplementationProvider | undefined {
    return this.providers.get(`${providerId}@${providerVersion}`);
  }

  get(
    providerId: string,
    providerVersion: string,
  ): AgentImplementationProvider {
    const p = this.find(providerId, providerVersion);
    if (!p)
      throw new AgentropyError(
        'NotFound',
        `Implementation provider ${providerId}@${providerVersion} not found`,
        { details: { kind: 'implementation-provider' } },
      );
    return p;
  }
}
