import { describe, expect, test } from 'bun:test';
import { createGateway, coreSupportsStaffAuth, type GatewayConfig, type FetchTransport } from './gateway.ts';
import type { handleAuthProxyRequest } from '@neondatabase/auth/server';

const config: GatewayConfig = {
  origin: 'http://localhost:4173', coreUrl: 'http://localhost:8787',
  authUrl: 'https://auth.example.invalid/neondb/auth', cookieSecret: 'a'.repeat(32), enabled: true,
};
const invitation = 'b'.repeat(43);
function request(path: string, options: RequestInit = {}) {
  return new Request(`${config.origin}${path}`, options);
}
function post(path: string, extra: Record<string, string> = {}, body = '{}') {
  return request(path, { method: 'POST', body,
    headers: { origin: config.origin, 'content-type': 'application/json', ...extra } });
}
const fakeFetch: FetchTransport = () => Promise.resolve(Response.json({ ok: true }));
const fakeProvider: typeof handleAuthProxyRequest = async () => Response.json({ ok: true });

describe('dashboard auth boundary', () => {
  test('auth is not enabled against the inherited unauthenticated core or an unavailable API', async () => {
    for (const health of [{ ok: true }, { auth: { enforced: false, provider: 'neon', contractVersion: 1 } },
      { auth: { enforced: true, provider: 'neon', contractVersion: 2 } }]) {
      expect(await coreSupportsStaffAuth(config.coreUrl, async () => Response.json(health))).toBe(false);
    }
    expect(await coreSupportsStaffAuth(config.coreUrl, async () => { throw new Error('unavailable'); })).toBe(false);
    expect(await coreSupportsStaffAuth(config.coreUrl, async () => Response.json({
      auth: { enforced: true, provider: 'neon', contractVersion: 1 },
    }))).toBe(true);
  });
  test('closed until explicitly enabled with provider and strong cookie secret', async () => {
    for (const override of [{ enabled: false }, { authUrl: undefined }, { cookieSecret: 'short' }]) {
      const gateway = createGateway({ ...config, ...override }, fakeFetch, fakeProvider);
      expect((await gateway(request('/api/surgeries'))).status).toBe(503);
      expect((await gateway(post('/auth/provider/sign-up/email'))).status).toBe(503);
    }
  });
  test('rejects cross-site, missing-origin writes and attacker hosts before forwarding', async () => {
    let calls = 0;
    const gateway = createGateway(config, fakeFetch, async () => { calls++; return Response.json({}); });
    expect((await gateway(post('/auth/provider/sign-in/email', { origin: 'https://evil.example' }))).status).toBe(403);
    expect((await gateway(request('/auth/provider/sign-in/email', { method: 'POST', body: '{}' }))).status).toBe(403);
    expect((await gateway(request('/auth/provider/get-session', { headers: { 'sec-fetch-site': 'cross-site' } }))).status).toBe(403);
    expect((await gateway(new Request('http://evil.example/auth/provider/get-session'))).status).toBe(403);
    expect(calls).toBe(0);
  });
  test('provider routes are limited to the account flow and exact methods', async () => {
    const gateway = createGateway(config, fakeFetch, fakeProvider);
    for (const path of ['/auth/provider/admin/create-user', '/auth/provider/sign-in/social', '/auth/provider/anything',
      '/auth/provider/token/extra', '/api/http://evil.example', '/api/surgeries/a%2Fb', '/api/auth/invitations/short']) {
      expect((await gateway(request(path))).status).toBe(404);
    }
    expect((await gateway(request('/auth/provider/sign-out'))).status).toBe(404);
    expect((await gateway(post('/auth/provider/token'))).status).toBe(404);
    expect((await gateway(request('/auth/provider/get-session'))).status).toBe(200);
  });
  test('clinical data requires a bearer token; only invite preview and access request are public', async () => {
    const gateway = createGateway(config, fakeFetch, fakeProvider);
    for (const path of ['/api/surgeries', '/api/auth/me', '/api/documents/doc_1/content']) {
      expect((await gateway(request(path))).status).toBe(401);
    }
    expect((await gateway(post('/api/auth/invitations'))).status).toBe(401);
    expect((await gateway(request(`/api/auth/invitations/${invitation}`))).status).toBe(200);
    expect((await gateway(post('/api/auth/access-requests'))).status).toBe(200);
  });
  test('limits login bursts per actual client address, ignoring spoofed forwarded address', async () => {
    const gateway = createGateway(config, fakeFetch, fakeProvider);
    for (let index = 0; index < 20; index++) {
      expect((await gateway(post('/auth/provider/sign-in/email', { 'x-forwarded-for': `spoof-${index}` }), 'client-one')).status).toBe(200);
    }
    const response = await gateway(post('/auth/provider/sign-in/email'), 'client-one');
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('60');
    expect((await gateway(post('/auth/provider/sign-in/email'), 'client-two')).status).toBe(200);
  });
  test('bounded stream rejects oversized auth JSON even without Content-Length', async () => {
    let calls = 0;
    const gateway = createGateway(config, fakeFetch, async () => { calls++; return Response.json({}); });
    expect((await gateway(post('/auth/provider/sign-up/email', {}, 'a'.repeat(16_385)))).status).toBe(413);
    expect(calls).toBe(0);
  });
  test('only account headers reach official toolkit, no spoofed proxy metadata', async () => {
    const gateway = createGateway(config, fakeFetch, async (input) => {
      expect(input.request.headers.get('x-forwarded-host')).toBeNull();
      expect(input.request.headers.get('authorization')).toBeNull();
      expect(input.request.headers.get('origin')).toBe(config.origin);
      expect(input.baseUrl).toBe(config.authUrl!);
      expect(input.sameSite).toBe('lax');
      return Response.json({ ok: true });
    });
    expect((await gateway(post('/auth/provider/sign-in/email', {
      'x-forwarded-host': 'evil.example', authorization: 'Bearer private-service-token',
    }))).status).toBe(200);
  });
  test('core requests forward bearer only to fixed core and do not forward redirects or cookies', async () => {
    const gateway = createGateway(config, async (input, options) => {
      expect(String(input)).toBe('http://localhost:8787/surgeries/sur_1');
      const headers = new Headers(options?.headers);
      expect(headers.get('authorization')).toBe('Bearer staff-token');
      expect(headers.get('cookie')).toBeNull();
      expect(options?.redirect).toBe('manual');
      return Response.redirect('https://evil.example');
    }, fakeProvider);
    expect((await gateway(request('/api/surgeries/sur_1', {
      headers: { authorization: 'Bearer staff-token', cookie: 'private=secret' },
    }))).status).toBe(502);
  });
});
