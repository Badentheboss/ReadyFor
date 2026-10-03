const root = import.meta.dir;
const mimeTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

Bun.serve({
  port: Number(Bun.env.DASHBOARD_PORT ?? 4173),
  fetch(request) {
    const pathname = new URL(request.url).pathname;
    const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
    if (!['index.html', 'styles.css', 'app.js'].includes(relativePath)) {
      return new Response('Not found', { status: 404 });
    }
    const file = Bun.file(`${root}/${relativePath}`);
    return new Response(file, { headers: { 'content-type': mimeTypes[relativePath.slice(relativePath.lastIndexOf('.'))] } });
  },
});

console.log(`ReadyFor dashboard available at http://localhost:${Bun.env.DASHBOARD_PORT ?? 4173}`);
