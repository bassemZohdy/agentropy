/**
 * Offline guard for test suites (AC-14 "whole suite runs with network disabled"): outbound TCP connects, DNS
 * lookups and `fetch` throw. Local IPC (Unix sockets / named pipes, used by test runners) stays available.
 *
 * The guard is process-global (TASK-033.3): its state lives on `globalThis`, so every module instance — the
 * package entry (`dist`) and the sources a setup file imports — sees the same guard. A suite that needs a live
 * endpoint names it with `allowNetwork(['127.0.0.1:5432'])`; everything else stays blocked.
 */
import dns from 'node:dns';
import net from 'node:net';

interface GuardState {
  remove?: () => void;
  allowed: Set<string>;
  NetworkDisabledError: new (what: string) => Error;
}

const KEY = Symbol.for('agentropy.testkit.networkGuard');
const state: GuardState = ((globalThis as Record<symbol, unknown>)[KEY] ??= {
  allowed: new Set<string>(),
  NetworkDisabledError: class NetworkDisabledError extends Error {
    constructor(what: string) {
      super(`Network access is disabled in tests (${what})`);
      this.name = 'NetworkDisabledError';
    }
  },
}) as GuardState;

/** Thrown by every blocked network call; the same class across module instances. */
export const NetworkDisabledError = state.NetworkDisabledError;
export type NetworkDisabledError = Error;

/** `host:port` of a `Socket#connect` call, or undefined for IPC (a path). */
function endpoint(args: unknown[]): string | undefined {
  const first = args[0];
  if (Array.isArray(first)) return endpoint(first);
  if (typeof first === 'string' && Number.isNaN(Number(first)))
    return undefined;
  if (typeof first === 'object' && first !== null) {
    const o = first as { path?: unknown; port?: unknown; host?: unknown };
    if (typeof o.path === 'string') return undefined;
    return `${typeof o.host === 'string' ? o.host : 'localhost'}:${String(o.port)}`;
  }
  return `${typeof args[1] === 'string' ? args[1] : 'localhost'}:${String(first)}`;
}

/** IP literals resolve without any network traffic; named hosts only when an allowed endpoint names them. */
const hostAllowed = (host: string) =>
  net.isIP(host) !== 0 ||
  [...state.allowed].some((e) => e.slice(0, e.lastIndexOf(':')) === host);

/** Installs the guard once per process; returns a function that removes it. */
export function blockNetwork(): () => void {
  if (state.remove) return state.remove;
  const connect = net.Socket.prototype.connect;
  const lookup = dns.lookup;
  const promisesLookup = dns.promises.lookup;
  const fetchFn = globalThis.fetch;
  net.Socket.prototype.connect = function (
    this: net.Socket,
    ...args: unknown[]
  ) {
    const at = endpoint(args);
    if (at !== undefined && !state.allowed.has(at))
      throw new NetworkDisabledError(`tcp connect ${at}`);
    return (connect as (...a: unknown[]) => net.Socket).apply(this, args);
  } as typeof connect;
  dns.lookup = ((host: string, ...rest: unknown[]) => {
    if (!hostAllowed(host)) throw new NetworkDisabledError('dns lookup');
    return (lookup as (...a: unknown[]) => unknown)(host, ...rest);
  }) as unknown as typeof dns.lookup;
  dns.promises.lookup = ((host: string, ...rest: unknown[]) =>
    hostAllowed(host)
      ? (promisesLookup as (...a: unknown[]) => unknown)(host, ...rest)
      : Promise.reject(
          new NetworkDisabledError('dns lookup'),
        )) as unknown as typeof dns.promises.lookup;
  globalThis.fetch = (() =>
    Promise.reject(
      new NetworkDisabledError('fetch'),
    )) as unknown as typeof fetch;
  state.remove = () => {
    net.Socket.prototype.connect = connect;
    dns.lookup = lookup;
    dns.promises.lookup = promisesLookup;
    globalThis.fetch = fetchFn;
    state.remove = undefined;
  };
  return state.remove;
}

/**
 * Lets TCP connects (and DNS lookups of the host) through to exactly these `host:port` endpoints while the guard
 * stays installed. `fetch` stays blocked. Returns a function that withdraws the permission.
 */
export function allowNetwork(endpoints: string[]): () => void {
  for (const e of endpoints)
    if (!/^[^\s:]+:\d+$/.test(e))
      throw new Error(`allowNetwork expects host:port, got ${e}`);
  const added = endpoints.filter((e) => !state.allowed.has(e));
  for (const e of added) state.allowed.add(e);
  return () => {
    for (const e of added) state.allowed.delete(e);
  };
}

/** `host:port` of a database or service URL, for `allowNetwork`. */
export function endpointOf(url: string, defaultPort: number): string {
  const u = new URL(url);
  return `${u.hostname}:${u.port || defaultPort}`;
}

export const isNetworkBlocked = (): boolean => state.remove !== undefined;
