/** Request-target parsing shared by the HTTP handlers (FIX-049). Internal: not part of the package's API. */

/**
 * The path of a request target, or `undefined` when the target is not a valid URL (`//`, `//[`, …). It never
 * throws: a handler answers `400` for such a request instead of rejecting, which a host would see as an
 * unhandled rejection from an unauthenticated caller.
 */
export function requestPath(url: string | undefined): string | undefined {
  try {
    return new URL(url ?? '/', 'http://localhost').pathname;
  } catch {
    return undefined;
  }
}
