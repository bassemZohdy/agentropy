/**
 * Registry federation and discovery (FEAT-028.9, M3-09, R-18) through A2A 1.0 agent cards — the discovery
 * standard Agentropy already speaks — instead of a registry protocol of its own.
 *
 * Publishing: `agentCardForDefinition` turns a local definition into an AgentCard for the A2A server endpoint
 * that exposes it (one card per endpoint, as in A2A). The definition ID travels as the card's first skill ID.
 *
 * Importing: `AgentDirectoryFederation` fetches the cards of **configured peers only** (no URL ever comes from a
 * caller or a card, so discovery cannot be turned into a request forgery), validates them strictly, keeps only
 * the fields it needs, and answers `discover` from that cache. Cards are untrusted data: size-capped, string
 * lengths capped, interface URLs must be https and same-origin with the card unless the peer allows the origin,
 * and text is never interpreted. Each peer is visible only to the tenants it is configured for, and every
 * result passes the same `definition:discover` policy check as local discovery (resource type `remote-agent`),
 * failing closed when the policy point is down. A result carries the delegation target
 * `{ remote: { endpoint, definitionId } }` for `delegate`.
 */
import {
  AgentropyError,
  enforcePolicy,
  isAgentropyError,
  type AgentDefinition,
  type PolicyDecisionPoint,
  type TrustedPrincipal,
} from '@agentropy/core';
import { A2A_PROTOCOL_VERSION, a2aAgentCard } from './a2a.js';
import { ReplyTooLarge, readBoundedText } from './bounded-body.js';
import type { DiscoveryQuery } from './registry.js';

/** A2A AgentCard for one local definition served at `url` (the A2A JSON-RPC endpoint). */
export function agentCardForDefinition(
  def: AgentDefinition,
  url: string,
  extra: {
    securitySchemes?: Record<string, unknown>;
    security?: Record<string, string[]>[];
    /** Advertise SSE streaming; set when the endpoint serves `A2AServer.stream` (e.g. `createA2AHttpHandler`). */
    streaming?: boolean;
    pushNotifications?: boolean;
  } = {},
): Record<string, unknown> {
  return a2aAgentCard({
    name: def.displayName,
    description: def.description ?? def.displayName,
    version: def.version,
    url,
    ...extra,
    skills: [
      {
        id: def.id,
        name: def.displayName,
        description: def.description ?? def.displayName,
        tags: [
          `profile:${def.profile.id}`,
          ...(def.capabilities ?? []).map((c) => `capability:${c.id}`),
        ],
      },
    ],
  });
}

export interface FederationPeer {
  /** Stable local name of the peer, e.g. `finance-eu`. */
  id: string;
  /** Where its card lives, e.g. `https://finance.example/.well-known/agent-card.json`. */
  cardUrl: string;
  /** Tenants that may discover and use this peer. */
  tenants: string[];
  /** Origins (besides the card's own) that the card may name as its endpoint. */
  allowedOrigins?: string[];
}

export interface RemoteAgentEntry {
  peerId: string;
  definitionId: string;
  name: string;
  description: string;
  version: string;
  endpoint: string;
  protocolVersion: string;
  tags: string[];
  fetchedAt: string;
  /** True when the last refresh of this peer failed and the entry is older than the refresh interval. */
  stale: boolean;
  /** Ready to pass as `DelegationRequest.target`. */
  target: {
    remote: { endpoint: string; definitionId: string; version: string };
  };
}

export interface FederationFetch {
  (
    url: string,
    init: {
      method: 'GET';
      headers: Record<string, string>;
      /** Fires at `timeoutMs`: the deadline covers the body as well as the headers. */
      signal?: AbortSignal;
    },
  ): Promise<{
    status: number;
    text(): Promise<string>;
    headers?: { get(name: string): string | null };
    body?: unknown;
  }>;
}

export interface FederationOptions {
  peers: FederationPeer[];
  fetch: FederationFetch;
  pdp: PolicyDecisionPoint;
  now?: () => string;
  /** A refresh younger than this is not repeated (default 5 min). */
  refreshMs?: number;
  /** Entries whose peer has not answered for this long are dropped (default 24 h). */
  maxStaleMs?: number;
  /** Largest card accepted (default 64 KiB). */
  maxCardBytes?: number;
  /** Deadline for fetching one card, headers and body (default 10 s). */
  timeoutMs?: number;
}

const MAX_TEXT = 1_000;
const MAX_TAGS = 32;

interface CacheEntry {
  entry: Omit<RemoteAgentEntry, 'stale'>;
  okAt: number;
  failedAt?: number;
}

export class AgentDirectoryFederation {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly o: FederationOptions) {
    const ids = new Set<string>();
    for (const p of o.peers) {
      if (!p.id || ids.has(p.id))
        throw new AgentropyError(
          'InvalidConfiguration',
          `Duplicate or empty peer id ${p.id}`,
        );
      ids.add(p.id);
      if (!/^https:\/\//.test(p.cardUrl))
        throw new AgentropyError(
          'InvalidConfiguration',
          `Peer ${p.id}: cardUrl must be https`,
        );
      if (!p.tenants?.length)
        throw new AgentropyError(
          'InvalidConfiguration',
          `Peer ${p.id}: at least one tenant required`,
        );
    }
  }

  private nowMs() {
    return Date.parse(this.o.now?.() ?? new Date().toISOString());
  }

  /** Fetch every peer's card whose cache is older than `refreshMs`. Failures keep the last good card. */
  async refresh(
    options: { force?: boolean } = {},
  ): Promise<{ peerId: string; ok: boolean; error?: string }[]> {
    const out: { peerId: string; ok: boolean; error?: string }[] = [];
    const now = this.nowMs();
    for (const peer of this.o.peers) {
      const cur = this.cache.get(peer.id);
      if (
        !options.force &&
        cur &&
        now - cur.okAt < (this.o.refreshMs ?? 300_000)
      )
        continue;
      try {
        const entry = await this.load(peer, now);
        this.cache.set(peer.id, { entry, okAt: now });
        out.push({ peerId: peer.id, ok: true });
      } catch (err) {
        if (cur) cur.failedAt = now;
        out.push({
          peerId: peer.id,
          ok: false,
          error: isAgentropyError(err) ? err.code : 'Internal',
        });
      }
    }
    return out;
  }

  private async load(
    peer: FederationPeer,
    now: number,
  ): Promise<Omit<RemoteAgentEntry, 'stale'>> {
    // One deadline for the whole card, headers and body: a peer that stalls cannot hold the refresh.
    const signal = AbortSignal.timeout(this.o.timeoutMs ?? 10_000);
    let res: Awaited<ReturnType<FederationFetch>>;
    try {
      res = await this.o.fetch(peer.cardUrl, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal,
      });
    } catch {
      throw new AgentropyError('RemoteUnavailable', 'Peer unreachable');
    }
    if (res.status !== 200) {
      void Promise.resolve(
        (
          res.body as { cancel?: () => Promise<unknown> } | undefined
        )?.cancel?.(),
      ).catch(() => undefined);
      throw new AgentropyError('RemoteUnavailable', 'Peer card unavailable', {
        details: { status: res.status },
      });
    }
    let text: string;
    try {
      text = await readBoundedText(
        res,
        this.o.maxCardBytes ?? 64 * 1024,
        signal,
      );
    } catch (err) {
      throw err instanceof ReplyTooLarge
        ? new AgentropyError('SchemaViolation', 'Agent card too large')
        : new AgentropyError(
            'RemoteUnavailable',
            'Peer card could not be read',
          );
    }
    let card: unknown;
    try {
      card = JSON.parse(text);
    } catch {
      throw new AgentropyError('SchemaViolation', 'Agent card is not JSON');
    }
    return this.validate(peer, card, new Date(now).toISOString());
  }

  private validate(
    peer: FederationPeer,
    raw: unknown,
    fetchedAt: string,
  ): Omit<RemoteAgentEntry, 'stale'> {
    const bad = (why: string) =>
      new AgentropyError('SchemaViolation', `Agent card: ${why}`);
    const c = raw as Record<string, unknown> | null;
    const str = (v: unknown, what: string) => {
      if (typeof v !== 'string' || !v || v.length > MAX_TEXT)
        throw bad(`${what} must be a non-empty string up to ${MAX_TEXT} chars`);
      return v;
    };
    if (!c || typeof c !== 'object') throw bad('not an object');
    const name = str(c.name, 'name');
    const description = str(c.description, 'description');
    const version = str(c.version, 'version');
    const ifaces = Array.isArray(c.supportedInterfaces)
      ? (c.supportedInterfaces as Record<string, unknown>[])
      : [];
    const iface = ifaces.find(
      (i) =>
        i?.protocolBinding === 'JSONRPC' &&
        i?.protocolVersion === A2A_PROTOCOL_VERSION,
    );
    if (!iface)
      throw bad(`no JSONRPC interface at protocol ${A2A_PROTOCOL_VERSION}`);
    const endpoint = str(iface.url, 'interface url');
    let origin: string;
    try {
      const u = new URL(endpoint);
      if (u.protocol !== 'https:') throw new Error();
      origin = u.origin;
    } catch {
      throw bad('interface url must be https');
    }
    const allowed = [
      new URL(peer.cardUrl).origin,
      ...(peer.allowedOrigins ?? []),
    ];
    if (!allowed.includes(origin))
      throw bad('interface url is not on an allowed origin');
    const skills = Array.isArray(c.skills)
      ? (c.skills as Record<string, unknown>[])
      : [];
    const definitionId =
      typeof skills[0]?.id === 'string' && skills[0].id.length <= 200
        ? skills[0].id
        : name;
    const tags = skills
      .flatMap((s) => (Array.isArray(s?.tags) ? s.tags : []))
      .filter((t): t is string => typeof t === 'string' && t.length <= 100)
      .slice(0, MAX_TAGS);
    return {
      peerId: peer.id,
      definitionId,
      name,
      description,
      version,
      endpoint,
      protocolVersion: A2A_PROTOCOL_VERSION,
      tags,
      fetchedAt,
      target: { remote: { endpoint, definitionId, version } },
    };
  }

  /**
   * Remote agents the caller may see, from the cache (call `refresh` on a schedule). Deterministic order: peer id,
   * then definition id. Same filters as local discovery: `id`, `capability` (tag `capability:<id>`), `profile`
   * (tag `profile:<id>`), `text` (name and description).
   */
  async discover(
    query: DiscoveryQuery,
    caller: TrustedPrincipal,
  ): Promise<RemoteAgentEntry[]> {
    if (!caller?.id || !caller.tenantId)
      throw new AgentropyError('Unauthenticated', 'No trusted principal');
    const now = this.nowMs();
    const refreshMs = this.o.refreshMs ?? 300_000;
    const maxStale = this.o.maxStaleMs ?? 86_400_000;
    const text = query.text?.toLowerCase();
    const out: RemoteAgentEntry[] = [];
    for (const peer of [...this.o.peers].sort((a, b) =>
      a.id.localeCompare(b.id),
    )) {
      if (!peer.tenants.includes(caller.tenantId)) continue;
      const cached = this.cache.get(peer.id);
      if (!cached || now - cached.okAt > maxStale) continue;
      const e = cached.entry;
      if (query.id && e.definitionId !== query.id) continue;
      if (
        query.capability &&
        !e.tags.includes(`capability:${query.capability}`)
      )
        continue;
      if (query.profile && !e.tags.includes(`profile:${query.profile}`))
        continue;
      if (text && !`${e.name} ${e.description}`.toLowerCase().includes(text))
        continue;
      try {
        await enforcePolicy(this.o.pdp, {
          principal: caller,
          action: 'definition:discover',
          resource: {
            type: 'remote-agent',
            id: `${e.peerId}/${e.definitionId}`,
            tenantId: caller.tenantId,
          },
        });
      } catch (err) {
        if (isAgentropyError(err, 'PermissionDenied')) continue;
        throw err;
      }
      out.push({
        ...e,
        stale:
          cached.failedAt !== undefined &&
          cached.failedAt > cached.okAt &&
          now - cached.okAt > refreshMs,
      });
    }
    return out;
  }
}
