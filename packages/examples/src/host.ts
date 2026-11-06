/**
 * Container host (FEAT-028.8, M3-08): runs one Agentropy runtime as a long-lived process with health endpoints, for
 * the image in deploy/Dockerfile and the Kubernetes/OpenShift manifests in deploy/. Applications replace
 * `defineAgents` with their own definitions and plug in their real policy point, audit sink and credentials.
 *
 * Configuration (environment):
 * - AGENTROPY_DB          SQLite file path on a persistent volume (default /data/agentropy.db)
 * - PORT                  health port (default 8080)
 * - AGENTROPY_ALLOW       comma-separated policy actions the sample policy allows; everything else is denied
 * - AGENTROPY_TICK_MS     scheduler interval (default 250)
 *
 * Endpoints: GET /healthz (process alive), GET /readyz (store answers a transaction, not shutting down).
 * SIGTERM stops accepting new scheduler ticks, waits for running executions, closes the store and exits.
 */
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import {
  BUILTIN_PROFILES,
  type PolicyDecision,
  type PolicyDecisionPoint,
  type PolicyRequest,
} from '@agentropy/core';
import { createLocalApp, type LocalApp } from '@agentropy/runtime';
import { SqliteStore } from '@agentropy/store-sqlite';

/** Sample policy: allow-list from configuration, deny by default. Replace with your PDP. */
export class AllowListPolicy implements PolicyDecisionPoint {
  private readonly allowed: Set<string>;
  constructor(actions: string) {
    this.allowed = new Set(
      actions
        .split(',')
        .map((a) => a.trim())
        .filter(Boolean),
    );
  }
  async decide(request: PolicyRequest): Promise<PolicyDecision> {
    return this.allowed.has(request.action)
      ? { effect: 'allow' }
      : { effect: 'deny', reason: 'not in AGENTROPY_ALLOW' };
  }
}

export interface HostState {
  shuttingDown: boolean;
}

/** Request handler for the health port; exported for tests (no socket needed). */
export function healthHandler(app: LocalApp, state: HostState) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const send = (status: number, body: Record<string, unknown>) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'GET') return send(405, { error: 'method not allowed' });
    if (req.url === '/healthz') return send(200, { status: 'ok' });
    if (req.url === '/readyz') {
      if (state.shuttingDown) return send(503, { status: 'shutting-down' });
      try {
        await app.store.transaction((tx) =>
          tx.get('leases', 'readiness-probe'),
        );
        return send(200, { status: 'ready' });
      } catch {
        // No error details on an unauthenticated endpoint.
        return send(503, { status: 'store-unavailable' });
      }
    }
    return send(404, { error: 'not found' });
  };
}

/** Sample agent so the image does something; replace with your own definitions. */
export function defineAgents(app: LocalApp): void {
  app.define(
    {
      id: 'echo',
      version: '1.0.0',
      displayName: 'Echo',
      profile: { id: 'task', version: '1.0.0' },
      implementation: {
        providerId: 'native-ts',
        providerVersion: '1.0.0',
        artifact: { id: 'echo', version: '1.0.0' },
      },
      inputSchema: true,
      runtimeRequirements: { guarantees: [] },
      policyRef: { id: 'default', version: '1.0.0' },
    },
    { handle: async (inv) => ({ kind: 'completed', output: inv.input }) },
  );
}

export async function main(env = process.env): Promise<void> {
  const app = createLocalApp({
    store: new SqliteStore({ path: env.AGENTROPY_DB ?? '/data/agentropy.db' }),
    pdp: new AllowListPolicy(env.AGENTROPY_ALLOW ?? ''),
    profiles: BUILTIN_PROFILES,
  });
  defineAgents(app);
  const state: HostState = { shuttingDown: false };
  const stop = app.start(Number(env.AGENTROPY_TICK_MS ?? 250));
  const server = createServer((req, res) => {
    void healthHandler(app, state)(req, res);
  });
  server.listen(Number(env.PORT ?? 8080));
  const shutdown = async () => {
    if (state.shuttingDown) return;
    state.shuttingDown = true;
    await stop();
    await app.store.close();
    server.close();
  };
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
}

if (import.meta.url === `file://${process.argv[1]}`) void main();
