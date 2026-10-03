const root = import.meta.dir;
const mimeTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.png': 'image/png',
};

const publicFiles = new Set([
  'index.html', 'styles.css', 'app.js', 'provider.js',
  'db/seed/fixtures.json', 'db/seed/assets/sample-lab-report.svg', 'db/seed/assets/sample-lab-report.png',
]);

Bun.serve({
  port: Number(Bun.env.DASHBOARD_PORT ?? 4173),
  fetch(request) {
    const pathname = new URL(request.url).pathname;
    const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
    if (relativePath === 'config.js') {
      const provider = Bun.env.DASHBOARD_PROVIDER === 'mock' ? 'mock' : 'core';
      const apiBaseUrl = Bun.env.READYFOR_CORE_URL ?? Bun.env.CORE_URL ?? 'http://localhost:8787';
      return new Response(`window.READYFOR_CONFIG = ${JSON.stringify({ provider, apiBaseUrl })};`, {
        headers: { 'content-type': 'text/javascript; charset=utf-8' },
      });
    }
    if (!publicFiles.has(relativePath)) {
      return new Response('Not found', { status: 404 });
    }
    const filePath = relativePath.startsWith('db/seed/')
      ? `${root}/../${relativePath}`
      : `${root}/${relativePath}`;
    const file = Bun.file(filePath);
    return new Response(file, { headers: { 'content-type': mimeTypes[relativePath.slice(relativePath.lastIndexOf('.'))] } });
  },
});

console.log(`ReadyFor dashboard available at http://localhost:${Bun.env.DASHBOARD_PORT ?? 4173}`);
