/**
 * Offline guard for test suites (AC-14 "whole suite runs with network disabled"): outbound TCP connects, DNS
 * lookups and `fetch` throw. Local IPC (Unix sockets / named pipes, used by test runners) stays available.
 */
import dns from 'node:dns';
import net from 'node:net';

export class NetworkDisabledError extends Error {
  constructor(what: string) {
    super(`Network access is disabled in tests (${what})`);
    this.name = 'NetworkDisabledError';
  }
}

let installed: (() => void) | undefined;

/** Installs the guard once per process; returns a function that removes it. */
export function blockNetwork(): () => void {
  if (installed) return installed;
  const connect = net.Socket.prototype.connect;
  const lookup = dns.lookup;
  const promisesLookup = dns.promises.lookup;
  const fetchFn = globalThis.fetch;
  const isIpc = (args: unknown[]) => {
    const first = args[0];
    if (typeof first === 'string') return Number.isNaN(Number(first));
    if (Array.isArray(first)) return isIpc(first);
    return (
      typeof first === 'object' &&
      first !== null &&
      'path' in first &&
      typeof (first as { path: unknown }).path === 'string'
    );
  };
  net.Socket.prototype.connect = function (
    this: net.Socket,
    ...args: unknown[]
  ) {
    if (!isIpc(args)) throw new NetworkDisabledError('tcp connect');
    return (connect as (...a: unknown[]) => net.Socket).apply(this, args);
  } as typeof connect;
  dns.lookup = (() => {
    throw new NetworkDisabledError('dns lookup');
  }) as unknown as typeof dns.lookup;
  dns.promises.lookup = (() =>
    Promise.reject(
      new NetworkDisabledError('dns lookup'),
    )) as unknown as typeof dns.promises.lookup;
  globalThis.fetch = (() =>
    Promise.reject(
      new NetworkDisabledError('fetch'),
    )) as unknown as typeof fetch;
  installed = () => {
    net.Socket.prototype.connect = connect;
    dns.lookup = lookup;
    dns.promises.lookup = promisesLookup;
    globalThis.fetch = fetchFn;
    installed = undefined;
  };
  return installed;
}

export const isNetworkBlocked = (): boolean => installed !== undefined;
