import { handleAuthProxyRequest } from '@neondatabase/auth/server';

export interface GatewayConfig {
  origin: string;
  coreUrl: string;
  authUrl?: string;
  cookieSecret?: string;
  enabled: boolean;
  /** HTTP loopback development only; production keeps Neon Secure cookies. */
  localHttpCookies?: boolean;
}
export type FetchTransport = (input: string | URL | Request, options?: RequestInit) => Promise<Response>;

export async function coreSupportsStaffAuth(coreUrl: string, coreFetch: FetchTransport = fetch): Promise<boolean> {
  try {
    const healthUrl = new URL(coreUrl);
    healthUrl.pathname = '/health';
    const response = await coreFetch(healthUrl, { redirect: 'manual', signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return false;
    const health = await response.json() as { auth?: string };
    return health.auth === 'neon';
  } catch { return false; }
}

const providerRoutes: Record<string, string> = {
  'get-session': 'GET', token: 'GET',
  'sign-up/email': 'POST', 'sign-in/email': 'POST', 'sign-out': 'POST',
  'email-otp/send-verification-otp': 'POST', 'email-otp/verify-email': 'POST',
  'forget-password/email-otp': 'POST', 'email-otp/reset-password': 'POST',
};

function failure(status: number, code: string, message: string) {
  return Response.json({ error: { code, message } }, { status });
}

async function boundedBody(request: Request, limit: number) {
  if (Number(request.headers.get('content-length')) > limit) throw new Error('body_too_large');
  if (!request.body) return undefined;
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new Error('body_too_large'); }
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { body.set(part, offset); offset += part.byteLength; }
  return body;
}

function localCookiesForNeon(value: string, prefix: string): string {
  const cookies = value.split(';').map((cookie) => cookie.trim());
  const localNames = new Set(cookies.filter((cookie) => cookie.startsWith(prefix))
    .map((cookie) => '__Secure-neon-auth.' + cookie.slice(prefix.length, cookie.indexOf('='))));
  // A previous Chrome session may have both names. The current local session wins.
  return cookies.filter((cookie) => !localNames.has(cookie.slice(0, cookie.indexOf('='))))
    .map((cookie) => cookie.startsWith(prefix) ? '__Secure-neon-auth.' + cookie.slice(prefix.length) : cookie).join('; ');
}

// Only the configured providers and these routes can be reached through this gateway.
export function createGateway(config: GatewayConfig, coreFetch: FetchTransport = fetch,
  providerProxy: typeof handleAuthProxyRequest = handleAuthProxyRequest) {
  const origin = new URL(config.origin);
  const localHttpCookies = config.localHttpCookies === true && origin.protocol === 'http:'
    && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
  const localCookiePrefix = `readyfor-dev-${origin.port || '80'}-neon-auth.`;
  const limits = new Map<string, { until: number; count: number }>();
  return async (request: Request, clientAddress = 'unknown'): Promise<Response> => {
    const url = new URL(request.url);
    const provider = url.pathname.startsWith('/auth/provider/');
    if (!provider && !url.pathname.startsWith('/api/')) return failure(404, 'not_found', 'Not found.');
    if (!config.enabled || !config.authUrl || !config.cookieSecret || config.cookieSecret.length < 32) {
      return failure(503, 'auth_not_configured', 'Staff sign-in is being configured.');
    }
    if (url.origin !== config.origin || request.headers.get('sec-fetch-site') === 'cross-site') {
      return failure(403, 'forbidden_origin', 'Use the ReadyFor dashboard to make this request.');
    }
    const origin = request.headers.get('origin');
    if ((origin && origin !== config.origin) || (request.method !== 'GET' && origin !== config.origin)) {
      return failure(403, 'forbidden_origin', 'Use the ReadyFor dashboard to make this request.');
    }
    if (!['GET', 'POST'].includes(request.method)) return failure(405, 'method_not_allowed', 'Method not allowed.');
    if (request.method === 'POST' && request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') {
      return failure(415, 'unsupported_media_type', 'Use a JSON request.');
    }
    const path = provider ? url.pathname.slice('/auth/provider/'.length) : url.pathname.slice('/api'.length);
    const routeAllowed = provider ? providerRoutes[path] === request.method :
      request.method === 'GET' ? /^\/(me|health|surgeries)$/.test(path)
        || /^\/surgeries\/[A-Za-z0-9_-]+(\/brief)?$/.test(path)
        || /^\/documents\/[A-Za-z0-9_-]+\/content$/.test(path)
        : /^\/(tasks|demo\/reset|messages\/inbound)$/.test(path)
          || /^\/surgeries\/[A-Za-z0-9_-]+\/check$/.test(path)
          || /^\/(tasks|requirements)\/[A-Za-z0-9_-]+\/actions$/.test(path);
    if (!routeAllowed) return failure(404, 'not_found', 'Not found.');
    if (!provider && !/^Bearer [^\s]+$/.test(request.headers.get('authorization') ?? '')) {
      return failure(401, 'unauthenticated', 'Sign in to continue.');
    }
    if (request.method === 'POST' && provider) {
      const now = Date.now();
      for (const [key, value] of limits) if (value.until <= now) limits.delete(key);
      const rateKey = `${clientAddress}:${provider ? 'auth' : 'access'}`;
      const current = limits.get(rateKey) ?? { until: now + 60_000, count: 0 };
      if (current.count >= 20 || (!limits.has(rateKey) && limits.size >= 10_000)) {
        const response = failure(429, 'rate_limited', 'Please wait before trying again.');
        response.headers.set('retry-after', '60');
        return response;
      }
      current.count++;
      limits.set(rateKey, current);
    }
    try {
      const body = await boundedBody(request, provider ? 16_384 : 9 * 1024 * 1024);
      if (provider) {
        // Neon handles HttpOnly cookies, SameSite and cache signing in its server toolkit.
        const headers = new Headers();
        for (const name of ['cookie', 'content-type', 'accept']) {
          const value = request.headers.get(name);
          if (value) headers.set(name, name === 'cookie' && localHttpCookies
            ? localCookiesForNeon(value, localCookiePrefix) : value);
        }
        headers.set('origin', config.origin);
        const sanitized = new Request(request.url, { method: request.method, headers, body });
        const response = await providerProxy({ request: sanitized, path, baseUrl: config.authUrl.replace(/\/$/, ''),
          cookieSecret: config.cookieSecret, sameSite: 'lax', sessionDataTtl: 60 });
        if (!localHttpCookies) return response;
        // WebKit rejects Secure cookies on HTTP localhost. Keep HttpOnly/SameSite,
        // translating only Neon's names across the loopback development boundary.
        const responseHeaders = new Headers(response.headers);
        responseHeaders.delete('set-cookie');
        for (const cookie of response.headers.getSetCookie()) {
          responseHeaders.append('set-cookie', cookie.startsWith('__Secure-neon-auth.')
            ? (localCookiePrefix + cookie.slice('__Secure-neon-auth.'.length))
              .replace(/;\s*Secure(?=;|$)/gi, '').replace(/;\s*Domain=[^;]*/gi, '')
            : cookie);
        }
        return new Response(response.body, { status: response.status, headers: responseHeaders });
      }
      const target = new URL(config.coreUrl);
      target.pathname = path;
      target.search = url.search;
      const headers = new Headers();
      for (const name of ['authorization', 'content-type', 'accept']) {
        const value = request.headers.get(name);
        if (value) headers.set(name, value);
      }
      const upstream = await coreFetch(target, { method: request.method, headers, body,
        redirect: 'manual', signal: AbortSignal.timeout(20_000) });
      if (upstream.status >= 300 && upstream.status < 400) return failure(502, 'upstream_failed', 'Unexpected API redirect.');
      return new Response(upstream.body, { status: upstream.status,
        headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' } });
    } catch (error) {
      return error instanceof Error && error.message === 'body_too_large'
        ? failure(413, 'body_too_large', 'This request is too large.')
        : failure(502, 'upstream_failed', 'The sign-in service is unavailable. Please try again.');
    }
  };
}
