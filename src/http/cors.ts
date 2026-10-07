/**
 * Origin allowlist + CORS headers. A request with no Origin header (server-to-server, curl,
 * uptime checks) is allowed — there is no browser Origin to enforce. A browser request with
 * an Origin not in the allowlist is rejected (403 origin_forbidden in the handler).
 * `'*'` in the allowlist opens it to any Origin (useful for the offline demo).
 */

export function isOriginAllowed(origin: string | null, allowed: string[]): boolean {
  if (!origin) return true;
  if (allowed.includes('*')) return true;
  return allowed.includes(origin);
}

export function corsHeaders(origin: string | null, allowed: string[]): Record<string, string> {
  const headers: Record<string, string> = {
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
    vary: 'Origin',
  };
  if (origin && (allowed.includes('*') || allowed.includes(origin))) {
    headers['access-control-allow-origin'] = allowed.includes('*') ? '*' : origin;
  }
  return headers;
}
