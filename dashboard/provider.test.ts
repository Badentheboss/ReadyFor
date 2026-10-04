import { expect, test } from 'bun:test';
import { createDashboardProvider } from './provider.js';

function summary() {
  return { surgery: { id:'sur_demo', procedureName:'Demo procedure', scheduledAt:'2026-10-08T12:00:00Z' },
    patient: { displayName:'Demo Patient' }, readiness: { level:'needs_attention', daysUntil:5, openBlockers:0 }, blockers:[] };
}

test('dashboard sends a fresh bearer on every API and image request and omits actor labels', async () => {
  const seen: string[] = [];
  let tokenCalls = 0;
  const server = Bun.serve({hostname:'127.0.0.1', port:0, async fetch(request) {
    const url = new URL(request.url);
    expect(request.headers.get('authorization')).toBe('Bearer staff-session');
    seen.push(`${request.method} ${url.pathname}`);
    if (request.method === 'POST' && request.headers.get('content-type')) {
      const body = await request.json() as Record<string, unknown>;
      expect(body.actor).toBeUndefined();
    }
    if (url.pathname.endsWith('/content')) return new Response('synthetic image', {headers:{'content-type':'image/png'}});
    if (url.pathname === '/surgeries') return Response.json({surgeries:[summary()]});
    if (url.pathname === '/surgeries/sur_demo') return Response.json({...summary(), requirements:[], tasks:[]});
    return Response.json({ok:true});
  }});
  const provider = createDashboardProvider({apiBaseUrl:server.url.origin, getAccessToken: async () => { tokenCalls++; return 'staff-session'; }});
  try {
    await provider.listSurgeries();
    await provider.getSurgery('sur_demo');
    await provider.refreshSurgery('sur_demo');
    await provider.resolveRequirement('req_demo','verify','forged-actor');
    await provider.createTask('sur_demo','Call demo patient','coordinator','Demo');
    await provider.completeTask('tsk_demo');
    await provider.sendPatientMessage('sur_demo','Synthetic reply');
    await provider.resetDemo();
    await provider.health();
    if (!('documentBlob' in provider) || !provider.documentBlob) throw new Error('Core image provider is missing.');
    expect(await (await provider.documentBlob('doc_demo')).text()).toBe('synthetic image');
    expect(seen).toContain('GET /documents/doc_demo/content');
    expect(tokenCalls).toBe(seen.length);
  } finally { server.stop(true); }
});

test('401 refreshes once, repeated 401 requests sign-in, and 403 is not retried', async () => {
  for (const statuses of [[401,200], [401,401], [403]]) {
    const refreshes: boolean[] = [];
    let calls = 0;
    let signins = 0;
    const server = Bun.serve({hostname:'127.0.0.1',port:0,fetch(request){
      const status = statuses[calls++] ?? 500;
      expect(request.headers.get('authorization')).toBe(`Bearer ${calls===1?'initial':'refreshed'}`);
      return Response.json(status===200 ? {surgeries:[]} : {error:{message:'Access rejected'}},{status});
    }});
    const provider = createDashboardProvider({apiBaseUrl:server.url.origin,
      getAccessToken:async (refresh = false) => { refreshes.push(refresh); return refresh?'refreshed':'initial'; },
      onUnauthorized:() => { signins++; }});
    try {
      if (statuses[1] === 200) expect(await provider.listSurgeries()).toEqual([]);
      else await expect(provider.listSurgeries()).rejects.toThrow('Access rejected');
      expect(calls).toBe(statuses.length);
      expect(refreshes).toEqual(statuses.length===2 ? [false,true] : [false]);
      expect(signins).toBe(statuses[1]===401 ? 1 : 0);
    } finally { server.stop(true); }
  }
});

test('every write is a JSON request, including actions with no payload', async () => {
  const writes: string[] = [];
  const server = Bun.serve({hostname:'127.0.0.1', port:0, async fetch(request) {
    const url = new URL(request.url);
    if (request.method === 'POST') {
      writes.push(`${url.pathname} ${request.headers.get('content-type')} ${await request.text()}`);
    }
    if (url.pathname === '/surgeries') return Response.json({surgeries:[summary()]});
    if (url.pathname === '/surgeries/sur_demo') return Response.json({...summary(), requirements:[], tasks:[]});
    return Response.json({ok:true});
  }});
  const provider = createDashboardProvider({apiBaseUrl:server.url.origin, getAccessToken: async () => 'staff-session'});
  try {
    await provider.refreshSurgery('sur_demo');
    await provider.resetDemo();
    await provider.retryMessage('msg_1');
    expect(writes).toEqual([
      '/surgeries/sur_demo/check application/json {}',
      '/demo/reset application/json {}',
      '/messages/msg_1/retry application/json {}',
    ]);
  } finally { server.stop(true); }
});

test('task filters are encoded and lastCheckedAt survives detail mapping', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname === '/tasks') {
      expect(url.searchParams.get('owner')).toBe('nurse & surgeon');
      expect(url.searchParams.get('status')).toBe('all');
      return Response.json({ tasks: [{ id: 'tsk_demo', surgeryId: 'sur_demo' }] });
    }
    return Response.json({ ...summary(), surgery: { ...summary().surgery, lastCheckedAt: '2026-10-04T12:00:00Z' }, requirements: [], tasks: [] });
  }) as unknown as typeof fetch;
  const provider = createDashboardProvider({ apiBaseUrl: 'http://core.test' });
  try {
    expect(await provider.listTasks({ owner: 'nurse & surgeon', status: 'all' })).toEqual([{ id: 'tsk_demo', surgeryId: 'sur_demo' }]);
    expect((await provider.getSurgery('sur_demo'))?.lastCheckedAt).toBe('2026-10-04T12:00:00Z');
  } finally { globalThis.fetch = originalFetch; }
});

test('mock tasks filter owners and status and share completion with case details', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({ surgeries: [{
    id: 'sur_mock', patient: { name: 'Morgan Mock', initials: 'MM' }, procedure: 'Demo',
    surgeryDate: '2026-10-08', readiness: 'ready', blockers: [],
    tasks: [{ title: 'Call clinic', owner: 'Nurse' }, { title: 'Arrange ride', owner: 'Coordinator' }],
  }] })) as unknown as typeof fetch;
  const provider = createDashboardProvider({ provider: 'mock' });
  try {
    const tasks = await provider.listTasks({ owner: 'nurse' });
    expect(tasks.length).toBe(1);
    expect(tasks[0].patientName).toBe('Morgan Mock');
    await provider.completeTask(tasks[0].id);
    expect(await provider.listTasks({ owner: 'nurse' })).toEqual([]);
    expect((await provider.listTasks({ owner: 'nurse', status: 'done' }))[0].status).toBe('done');
    expect((await provider.getSurgery('sur_mock'))?.tasks[0].status).toBe('done');
    expect((await provider.listTasks({ status: 'all' })).length).toBe(2);
  } finally { globalThis.fetch = originalFetch; }
});
