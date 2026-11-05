/** Shared setup for the M1 examples: an offline local app with an explicit tenant-scoped policy. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AgentDefinition,
  PolicyDecision,
  PolicyDecisionPoint,
  PolicyRequest,
  TrustedPrincipal,
} from '@agentropy/core';
import { SqliteStore } from '@agentropy/store-sqlite';

/**
 * Example policy: allow every action inside the caller's tenant. Real deployments plug in their own PDP;
 * Agentropy never assumes allow-all, so the examples state it explicitly.
 */
export class SameTenantPolicy implements PolicyDecisionPoint {
  readonly decisions: PolicyRequest[] = [];
  async decide(request: PolicyRequest): Promise<PolicyDecision> {
    this.decisions.push(request);
    return request.principal.tenantId === request.resource.tenantId
      ? { effect: 'allow', policyVersion: 'example-1' }
      : { effect: 'deny', reason: 'other tenant' };
  }
}

/** A durable SQLite file in a fresh temp directory (monitoring and task agents need durable execution). */
export function tempStore(tag: string, path?: string): SqliteStore {
  return new SqliteStore({
    path:
      path ?? join(mkdtempSync(join(tmpdir(), `agentropy-${tag}-`)), 'app.db'),
  });
}

export const user = (id: string, tenantId = 'acme-corp'): TrustedPrincipal => ({
  id,
  type: 'user',
  tenantId,
});

/** Minimal native-ts definition with sensible defaults for the examples. */
export function definition(
  id: string,
  over: Partial<AgentDefinition> = {},
): AgentDefinition {
  return {
    id,
    version: '1.0.0',
    displayName: id,
    profile: { id: 'task', version: '1.0.0' },
    implementation: {
      providerId: 'native-ts',
      providerVersion: '1.0.0',
      artifact: { id, version: '1.0.0' },
    },
    inputSchema: true,
    runtimeRequirements: { guarantees: [] },
    policyRef: { id: 'example', version: '1.0.0' },
    ...over,
  };
}

/** True when this module is the process entry point (`node dist/<file>.js`). */
export const isMain = (url: string): boolean =>
  process.argv[1] !== undefined &&
  url === new URL(`file://${process.argv[1]}`).href;
