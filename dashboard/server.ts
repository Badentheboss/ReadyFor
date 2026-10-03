import { createGateway, coreSupportsStaffAuth } from './gateway.ts';

const root = import.meta.dir;
const port = Number(Bun.env.DASHBOARD_PORT ?? 4173);
const origin = new URL(Bun.env.DASHBOARD_ORIGIN ?? `http://localhost:${port}`).origin;
const localOrigin = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname);
const demoMode = Bun.env.DASHBOARD_PROVIDER === 'mock' && localOrigin && Bun.env.NODE_ENV !== 'production';
if (Bun.env.DASHBOARD_PROVIDER === 'mock' && !demoMode) throw new Error('Mock mode is restricted to local development.');
const authUrl = Bun.env.NEON_AUTH_BASE_URL;
const cookieSecret = Bun.env.NEON_AUTH_COOKIE_SECRET;
const coreUrl = Bun.env.READYFOR_CORE_URL ?? Bun.env.CORE_URL ?? 'http://localhost:8787';
const providerConfigured = Boolean(authUrl) && Boolean(cookieSecret && cookieSecret.length >= 32);
const authConfigured = providerConfigured && await coreSupportsStaffAuth(coreUrl);
if (authUrl && new URL(authUrl).protocol !== 'https:') throw new Error('Neon Auth requires an HTTPS upstream URL.');
const gateway = createGateway({ origin, enabled: authConfigured, authUrl, cookieSecret,
  coreUrl });

const bundle = await Bun.build({ entrypoints: [`${root}/auth.js`], target: 'browser', minify: true });
if (!bundle.success || !bundle.outputs[0]) throw new Error('Could not build the staff sign-in client.');
const authBundle = await bundle.outputs[0].text();
const mimeTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8', '.png': 'image/png',
};
const publicFiles = new Set(['index.html', 'styles.css', 'auth.css', 'app.js', 'provider.js',
  'db/seed/fixtures.json', 'db/seed/assets/sample-lab-report.svg', 'db/seed/assets/sample-lab-report.png']);

function secure(response: Response) {
  response.headers.set('cache-control', 'no-store');
  response.headers.set('x-content-type-options', 'nosniff');
  response.headers.set('referrer-policy', 'no-referrer');
  response.headers.set('x-frame-options', 'DENY');
  response.headers.set('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; style-src-attr 'unsafe-inline'; font-src 'self' https://fonts.gstatic.com; img-src 'self' blob: data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  if (Bun.env.NODE_ENV === 'production') response.headers.set('strict-transport-security', 'max-age=31536000');
  return response;
}

Bun.serve({
  port,
  hostname: localOrigin ? 'localhost' : '0.0.0.0',
  async fetch(request, server) {
    const pathname = new URL(request.url).pathname;
    if (pathname.startsWith('/auth/provider/') || pathname.startsWith('/api/')) {
      return secure(await gateway(request, server.requestIP(request)?.address));
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') return secure(new Response('Method not allowed', { status: 405 }));
    const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
    if (relativePath === 'config.js') {
      return secure(new Response(`window.READYFOR_CONFIG = ${JSON.stringify({
        provider: demoMode ? 'mock' : 'core', apiBaseUrl: '/api', authConfigured, demoMode,
      })};`, { headers: { 'content-type': mimeTypes['.js']! } }));
    }
    if (relativePath === 'auth.js') return secure(new Response(authBundle, { headers: { 'content-type': mimeTypes['.js']! } }));
    if (!publicFiles.has(relativePath)) return secure(new Response('Not found', { status: 404 }));
    const filePath = relativePath.startsWith('db/seed/') ? `${root}/../${relativePath}` : `${root}/${relativePath}`;
    return secure(new Response(Bun.file(filePath), { headers: { 'content-type': mimeTypes[relativePath.slice(relativePath.lastIndexOf('.'))]! } }));
  },
});
console.log(`ReadyFor dashboard available at ${origin}${demoMode ? ' (synthetic mock, no staff auth)' : ''}`);
