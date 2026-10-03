const root = import.meta.dir;
const mimeTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

const publicFiles = new Set(['index.html', 'styles.css', 'app.js', 'provider.js', 'db/seed/fixtures.json']);

Bun.serve({
  port: Number(Bun.env.DASHBOARD_PORT ?? 4173),
  fetch(request) {
    const pathname = new URL(request.url).pathname;
    const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
    if (relativePath === 'config.js') {
      const provider = Bun.env.DASHBOARD_PROVIDER === 'core' ? 'core' : 'mock';
      return new Response(`window.READYFOR_CONFIG = ${JSON.stringify({ provider })};`, {
        headers: { 'content-type': 'text/javascript; charset=utf-8' },
      });
    }
    if (!publicFiles.has(relativePath)) {
      return new Response('Not found', { status: 404 });
    }
    const filePath = relativePath === 'db/seed/fixtures.json'
      ? `${root}/../db/seed/fixtures.json`
      : `${root}/${relativePath}`;
    const file = Bun.file(filePath);
    return new Response(file, { headers: { 'content-type': mimeTypes[relativePath.slice(relativePath.lastIndexOf('.'))] } });
  },
});

console.log(`ReadyFor dashboard available at http://localhost:${Bun.env.DASHBOARD_PORT ?? 4173}`);
