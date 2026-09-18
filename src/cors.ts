/**
 * CORS for the surfaces a browser dapp calls directly.
 *
 * A dapp sends its key as `x-api-key`, a non-simple header, so the browser
 * preflights every call with an OPTIONS request. Without an answer the Bee
 * façade is unusable from a browser: the preflight fell through to the admin
 * passthrough and got a 401, and even /health carried no
 * Access-Control-Allow-Origin.
 *
 * Opening the origin opens nothing else, because nothing here is ambient: no
 * cookies, no basic auth, no credentials mode. Every request authenticates
 * with a header the caller must already hold, and anyone holding one can use
 * curl, which ignores CORS entirely. CORS stops browsers leaking ambient
 * credentials, and there are none to leak.
 *
 * What does stay closed is the admin surface. /api/admin/* and the node
 * passthrough get no CORS headers, and `x-admin-token` is never an allowed
 * request header on any path. A browser page cannot drive the endpoints that
 * spend, even on a path that shares a prefix with a public one
 * (`POST /stamps/{amount}/{depth}` reaches the passthrough).
 */

/** Paths a dapp may call from a browser. Everything else gets no CORS headers. */
const PUBLIC_PATH = /^\/(health|stamps|bytes|bzz|tags)(\/|$)|^\/api\/(apps|public)(\/|$)/;

/**
 * Request headers a browser may send. Bee's own `swarm-*` upload headers, the
 * two ways to present an app key, and the wallet-signature headers of
 * /api/apps/:app/upload. Deliberately not `x-admin-token`.
 */
const ALLOWED_HEADER = /^(swarm-[a-z0-9-]+|x-api-key|authorization|content-type|accept|x-address|x-signature|x-timestamp|x-filename|x-content-type)$/;

const METHODS = 'GET, HEAD, POST, OPTIONS';

/** A day: preflights are per-URL, and a dapp fetches many references. */
const MAX_AGE_SECONDS = '86400';

/**
 * Parse CORS_ORIGINS: `*`, or a comma-separated list of exact origins.
 * Trailing slashes are dropped because an Origin header never carries one, and
 * a configured `https://app.example/` would otherwise silently match nothing.
 */
export function parseOrigins(raw: string): string[] {
  return raw.split(',').map((o) => o.trim().replace(/\/+$/, '')).filter(Boolean);
}

export function isCorsPath(path: string): boolean {
  return PUBLIC_PATH.test(path);
}

/** The Access-Control-Allow-Origin value for this request, or null if refused. */
export function allowOrigin(origin: string | null, allowed: string[]): string | null {
  if (!origin) return null;
  if (allowed.includes('*')) return '*';
  return allowed.includes(origin) ? origin : null;
}

/**
 * Headers for a response to `request`, or null when it gets none: not a
 * browser cross-origin request, not a public path, or an origin not allowed.
 */
export function corsHeaders(request: Request, allowed: string[]): Record<string, string> | null {
  const path = new URL(request.url).pathname;
  if (!isCorsPath(path)) return null;
  const origin = allowOrigin(request.headers.get('origin'), allowed);
  if (!origin) return null;

  const headers: Record<string, string> = { 'access-control-allow-origin': origin };
  // A per-origin answer must not be cached and served to another origin.
  if (origin !== '*') headers.vary = 'Origin';

  if (request.method === 'OPTIONS') {
    const requested = (request.headers.get('access-control-request-headers') ?? '')
      .split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
    headers['access-control-allow-methods'] = METHODS;
    headers['access-control-allow-headers'] = requested.filter((h) => ALLOWED_HEADER.test(h)).join(', ');
    headers['access-control-max-age'] = MAX_AGE_SECONDS;
  }
  return headers;
}
