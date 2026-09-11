const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function parseHost(rawHost) {
  if (typeof rawHost !== 'string' || !rawHost.trim()) return null;
  try {
    return new URL(`http://${rawHost}`);
  } catch {
    return null;
  }
}

function isLoopbackHostname(hostname) {
  return LOOPBACK_HOSTS.has(String(hostname || '').toLowerCase());
}

function localOriginMatches(origin, host) {
  if (!origin) return true;
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' || !isLoopbackHostname(parsed.hostname)) return false;
  // Same-port local origins are accepted even when one spells the host as localhost and the
  // other as 127.0.0.1. IdleProof never intentionally serves its control plane off-loopback.
  return (parsed.port || '') === (host.port || '');
}

/**
 * Validate the browser-facing localhost trust boundary before routing a request.
 *
 * Binding to 127.0.0.1 prevents remote network access, but is not sufficient by itself: hostile
 * web pages can attempt cross-site writes to localhost and DNS-rebinding attacks can present an
 * attacker-controlled Host header that resolves to loopback. We therefore reject non-loopback
 * Host values and reject mutating browser requests whose Origin/Sec-Fetch-Site is not local.
 *
 * Requests without Origin remain allowed so project-local CLI/process integrations continue to
 * work. They are already constrained by the operating-system user's access to the local port.
 */
export function validateLocalRequest(req) {
  const host = parseHost(req?.headers?.host);
  if (!host || !isLoopbackHostname(host.hostname)) {
    return { ok: false, status: 421, error: 'IdleProof only accepts loopback Host headers.' };
  }

  const method = String(req?.method || 'GET').toUpperCase();
  if (!MUTATING_METHODS.has(method)) return { ok: true };

  const fetchSite = String(req?.headers?.['sec-fetch-site'] || '').toLowerCase();
  if (fetchSite === 'cross-site') {
    return { ok: false, status: 403, error: 'Cross-site writes to the IdleProof control plane are forbidden.' };
  }

  if (!localOriginMatches(req?.headers?.origin, host)) {
    return { ok: false, status: 403, error: 'IdleProof only accepts writes from its local origin.' };
  }

  return { ok: true };
}
