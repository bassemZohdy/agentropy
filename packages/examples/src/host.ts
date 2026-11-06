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
 * - AGENTROPY_A2A_TOKENS  enables the A2A endpoint: comma-separated `token=principalId` bearer tokens (sample
 *                         authentication; replace `bearerTokens` with your identity provider)
 * - AGENTROPY_TENANT      tenant of those principals and of the exposed instance (default `default`)
 * - AGENTROPY_PUBLIC_URL  external base URL written into the AgentCard (default http://localhost:PORT)
 *
 * Endpoints: GET /healthz (process alive), GET /readyz (store answers a transaction, the scheduler loop is not
 * stalled, not shutting down); with AGENTROPY_A2A_TOKENS also POST /a2a (A2A JSON-RPC, SSE streaming) and
 * GET /.well-known/agent-card.json. A scheduler tick that fails is logged to stderr and the loop goes on.
 * SIGTERM stops accepting new scheduler ticks, waits for running executions, closes the store and exits.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
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
  type TrustedPrincipal,
} from '@agentropy/core';
import {
  agentCardForDefinition,
  createA2AHttpHandler,
  createA2AServer,
  createLocalApp,
  localAppTarget,
  type A2AHttpHandler,
  type LocalApp,
  type SchedulerStatus,
} from '@agentropy/runtime';
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

/** Ticks that may fail in a row before readiness drops. */
const STALLED_AFTER_FAILURES = 3;

/**
 * A started scheduler loop counts as stalled when its last good tick is older than 30 s (or 20 intervals, whichever
 * is longer) or when `STALLED_AFTER_FAILURES` ticks failed in a row (FEAT-037.1).
 */
export function schedulerStalled(s: SchedulerStatus, nowMs: number): boolean {
  if (!s.running) return false;
  if (s.consecutiveFailures >= STALLED_AFTER_FAILURES) return true;
  const last = Date.parse(s.lastTickAt ?? s.startedAt ?? '');
  return (
    Number.isFinite(last) &&
    nowMs - last > Math.max(30_000, 20 * (s.intervalMs ?? 250))
  );
}

/** Request handler for the health port; exported for tests (no socket needed). */
export function healthHandler(
  app: LocalApp,
  state: HostState,
  now: () => number = Date.now,
) {
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
      } catch {
        // No error details on an unauthenticated endpoint.
        return send(503, { status: 'store-unavailable' });
      }
      if (schedulerStalled(app.schedulerStatus(), now()))
        return send(503, { status: 'scheduler-stalled' });
      return send(200, { status: 'ready' });
    }
    return send(404, { error: 'not found' });
  };
}

const digest = (s: string) => createHash('sha256').update(s).digest();

/**
 * Sample A2A authentication: static bearer tokens (`token=principalId`, comma-separated), all principals in one
 * tenant. Tokens are compared in constant time. Replace with your identity provider (OIDC/JWT verification, mTLS,
 * or headers from a trusted gateway).
 */
export function bearerTokens(
  spec: string,
  tenantId: string,
): (req: IncomingMessage) => Promise<TrustedPrincipal | undefined> {
  const entries = spec
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean)
    .map((e) => {
      const i = e.indexOf('=');
      if (i <= 0 || i === e.length - 1)
        throw new Error('AGENTROPY_A2A_TOKENS entries are token=principalId');
      return { digest: digest(e.slice(0, i)), id: e.slice(i + 1) };
    });
  return async (req) => {
    const m = /^Bearer (\S+)$/.exec(String(req.headers.authorization ?? ''));
    if (!m) return undefined;
    const d = digest(m[1]!);
    const hit = entries.find((e) => timingSafeEqual(e.digest, d));
    return hit ? { id: hit.id, type: 'service', tenantId } : undefined;
  };
}

/** The A2A endpoint exposing the sample `echo` agent, or undefined when AGENTROPY_A2A_TOKENS is not set. */
export async function a2aEndpoint(
  app: LocalApp,
  env: Record<string, string | undefined>,
): Promise<A2AHttpHandler | undefined> {
  if (!env.AGENTROPY_A2A_TOKENS) return undefined;
  const tenantId = env.AGENTROPY_TENANT ?? 'default';
  const host: TrustedPrincipal = { id: 'host', type: 'service', tenantId };
  const def = app.definitions.get({ id: 'echo', version: '1.0.0' });
  if (!def) throw new Error('echo agent is not defined');
  const inst = await app.createInstance(
    {
      definition: { id: def.id, version: def.version },
      ownerId: host.id,
      idempotencyKey: 'host-a2a-echo',
    },
    host,
  );
  const url = `${env.AGENTROPY_PUBLIC_URL ?? `http://localhost:${env.PORT ?? 8080}`}/a2a`;
  return createA2AHttpHandler(
    createA2AServer(localAppTarget(app), { instanceId: inst.id }),
    {
      authenticate: bearerTokens(env.AGENTROPY_A2A_TOKENS, tenantId),
      agentCard: agentCardForDefinition(def, url, {
        securitySchemes: {
          bearer: { httpAuthSecurityScheme: { scheme: 'Bearer' } },
        },
        security: [{ bearer: [] }],
        streaming: true,
      }),
    },
  );
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
  const stop = app.start(Number(env.AGENTROPY_TICK_MS ?? 250), {
    // One line per failed tick, no payloads: the loop itself goes on and readiness reports a stall.
    onError: (error) =>
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'scheduler.tick',
          code: error.code,
          message: error.message,
        }),
      ),
  });
  const a2a = await a2aEndpoint(app, env);
  const health = healthHandler(app, state);
  const server = createServer((req, res) => {
    void (async () => {
      if (a2a && (await a2a.handle(req, res))) return;
      await health(req, res);
    })();
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
