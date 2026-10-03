import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import seedJson from '../db/seed/demo.json';
import { parseStaffAllowlist, type TokenVerifier } from '../core/src/auth/auth.ts';
import { createApp } from '../core/src/http/app.ts';
import { openMemoryStore } from '../core/src/store/open.ts';
import type { ApiError, AppDeps, Requirement, SeedData, Store, SurgeryDetail } from '../core/src/types.ts';
import { coreSupportsStaffAuth, createGateway, type FetchTransport, type GatewayConfig } from './gateway.ts';

const seed = seedJson as SeedData;
const now = new Date('2026-10-03T20:00:00.000Z');
const config: GatewayConfig = {
  origin: 'http://localhost:4173', coreUrl: 'http://localhost:8787',
  authUrl: 'https://auth.example.invalid/neondb/auth', cookieSecret: 'c'.repeat(32), enabled: true,
};
// Only replace signature verification: real core allowlist resolution and permission checks run below.
const verifyToken: TokenVerifier = async (token) => {
  switch (token) {
    case 'coordinator-session': return { sub: 'user-dana', email: 'dana@example.edu', emailVerified: true };
    case 'nurse-session': return { sub: 'user-priya', email: 'priya@example.edu', emailVerified: true };
    case 'admin-session': return { sub: 'user-root', email: 'root@example.edu', emailVerified: true };
    case 'unlisted-session': return { sub: 'user-outsider', email: 'outsider@example.edu', emailVerified: true };
    case 'unverified-session': return { sub: 'user-dana', email: 'dana@example.edu', emailVerified: false };
    default: throw new Error('Invalid signature or expired JWT');
  }
};

let store: Store;
let core: ReturnType<typeof createApp>;
let gateway: ReturnType<typeof createGateway>;
let coreTransport: FetchTransport;

beforeAll(async () => { store = await openMemoryStore(); });
beforeEach(async () => {
  await store.reset(seed, now);
  const deps: AppDeps = {
    store, clock: { now: () => now }, seed: () => seed,
    clinic: { name: 'Northstar Surgical Center', phone: '(734) 555-0100' },
    info: { llm: 'fake', database: 'memory', records: 'fixtures' },
    auth: { verifyToken, staff: parseStaffAllowlist(
      'dana@example.edu,coordinator,Dana;priya@example.edu,nurse,Priya;root@example.edu,admin,Root',
    ) },
    corsOrigins: [config.origin],
    runRecordCheck: async (surgeryId) => ({ surgeryId, created: [], changed: [], outbound: [], warnings: [] }),
    handleInbound: async () => ({ surgeryId: 'sur_harriet', messageId: 'msg_unused', classification: null, replies: [], effects: [] }),
  };
  core = createApp(deps);
  coreTransport = async (input, options) => core.fetch(input instanceof Request
    ? new Request(input, options) : new Request(String(input), options));
  gateway = createGateway(config, coreTransport, async () => {
    throw new Error('This integration must not contact the Neon provider');
  });
});

function call(path: string, token?: string, body?: unknown) {
  const headers = new Headers();
  if (token) headers.set('authorization', `Bearer ${token}`);
  if (body !== undefined) {
    headers.set('origin', config.origin);
    headers.set('content-type', 'application/json');
  }
  return gateway(new Request(`${config.origin}/api${path}`, {
    method: body === undefined ? 'GET' : 'POST', headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
}

async function requirementId(key: string) {
  const requirement = (await store.listRequirements('sur_jordan')).find((item) => item.key === key);
  if (!requirement) throw new Error(`Missing seeded requirement: ${key}`);
  return requirement.id;
}

describe('dashboard gateway with the authenticated core', () => {
  test('recognizes the real health contract and returns server-resolved staff identities', async () => {
    expect(await coreSupportsStaffAuth(config.coreUrl, coreTransport)).toBe(true);
    for (const [token, role, name, userId] of [
      ['coordinator-session', 'coordinator', 'Dana', 'user-dana'],
      ['nurse-session', 'nurse', 'Priya', 'user-priya'],
      ['admin-session', 'admin', 'Root', 'user-root'],
    ]) {
      const response = await call('/me', token);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        identity: { kind: 'staff', role, name, userId }, actor: `${role}:${name}`, auth: 'neon',
      });
    }
  });

  test('staff can read seeded surgery data through the gateway', async () => {
    const response = await call('/surgeries/sur_jordan', 'coordinator-session');
    expect(response.status).toBe(200);
    const detail = await response.json() as SurgeryDetail;
    expect(detail.surgery.id).toBe('sur_jordan');
    expect(detail.patient.displayName).toBe('Jordan Ellis');
    expect(detail.requirements.length).toBeGreaterThan(0);
  });

  test('missing, expired, forged, unlisted and unverified credentials expose no clinical data', async () => {
    for (const [token, expectedStatus] of [
      [undefined, 401], ['expired-session', 401], ['forged-session', 401],
      ['unlisted-session', 403], ['unverified-session', 403],
    ] as const) {
      for (const path of ['/me', '/surgeries/sur_jordan']) {
        const response = await call(path, token);
        expect(response.status).toBe(expectedStatus);
        const result = await response.json() as ApiError & { patient?: unknown; identity?: unknown };
        expect(result.error).toBeDefined();
        expect(result.patient).toBeUndefined();
        expect(result.identity).toBeUndefined();
      }
    }
  });

  test('a coordinator can verify instructions but clinical decisions need a clinical role', async () => {
    const labId = await requirementId('preop_labs');
    expect((await call(`/requirements/${labId}/actions`, 'coordinator-session', { action: 'reopen' })).status).toBe(403);
    expect((await store.getRequirement(labId))?.status).toBe('verified');
    expect((await call(`/requirements/${labId}/actions`, 'nurse-session', { action: 'reopen' })).status).toBe(200);

    const instructionId = await requirementId('fasting_ack');
    const response = await call(`/requirements/${instructionId}/actions`, 'coordinator-session', {
      action: 'verify', actor: 'admin:Impostor',
    });
    expect(response.status).toBe(200);
    const result = await response.json() as { requirement: Requirement };
    expect(result.requirement.verifiedBy).toBe('coordinator:Dana');
  });

  test('demo reset requires admin permission at the core boundary', async () => {
    expect((await call('/demo/reset', 'coordinator-session', {})).status).toBe(403);
    expect((await call('/demo/reset', 'nurse-session', {})).status).toBe(403);
    const response = await call('/demo/reset', 'admin-session', {});
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, surgeries: seed.surgeries.length });
  });

  test('lab content requires a bearer token and retains image bytes through the gateway', async () => {
    const bytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const document = await store.createDocument({
      surgeryId: 'sur_jordan', mimeType: 'image/png', base64: Buffer.from(bytes).toString('base64'),
      status: 'needs_verification',
    });
    const path = `/documents/${document.id}/content`;
    expect((await call(path)).status).toBe(401);
    expect((await call(path, 'expired-session')).status).toBe(401);
    expect((await call(path, 'unlisted-session')).status).toBe(403);
    const response = await call(path, 'nurse-session');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });
});
