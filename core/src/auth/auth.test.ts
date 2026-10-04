import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import seedJson from "../../../db/seed/demo.json";
import { createApp } from "../http/app.ts";
import { openMemoryStore } from "../store/open.ts";
import type { AppDeps, SeedData, Store } from "../types.ts";
import { authConfigFromEnv, parseStaffAllowlist, type AuthConfig } from "./auth.ts";

const seed = seedJson as SeedData;
const NOW = new Date("2026-10-03T20:00:00.000Z");
const IMESSAGE_TOKEN = "i".repeat(40);
const AGENT_TOKEN = "a".repeat(40);

// Fake verifier: a token "jwt:<sub>:<email>:<verified>" stands in for a signed Neon Auth JWT.
const auth: AuthConfig = {
  verifyToken: async (token) => {
    const [kind, sub, email, verified] = token.split(":");
    if (kind !== "jwt") throw new Error("bad signature");
    return { sub, email, emailVerified: verified === "1" };
  },
  staff: parseStaffAllowlist(
    "dana@example.edu,coordinator,Dana; id:user-priya,nurse,Priya,agent1priya; root@example.edu,admin,Root; id:user-cole,coordinator,Cole,agent1cole",
  ),
  imessageToken: IMESSAGE_TOKEN,
  agentToken: AGENT_TOKEN,
};

let store: Store;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  store = await openMemoryStore();
});

beforeEach(async () => {
  const deps: AppDeps = {
    store,
    clock: { now: () => NOW },
    runRecordCheck: async (surgeryId) => ({ surgeryId, created: [], changed: [], outbound: [], warnings: [] }),
    handleInbound: async () => ({ surgeryId: "sur_harriet", messageId: "msg_x", classification: null, replies: [], effects: [] }),
    seed: () => seed,
    clinic: { name: "Northstar Surgical Center", phone: "(734) 555-0100" },
    info: { llm: "fake", database: "memory", records: "fixtures" },
    auth,
    corsOrigins: ["http://localhost:4173"],
  };
  app = createApp(deps);
  await store.reset(seed, NOW);
});

const DANA = "jwt:user-dana:dana@example.edu:1";
const PRIYA = "jwt:user-priya:priya@example.edu:0";
const ROOT = "jwt:user-root:root@example.edu:1";

async function call(method: string, path: string, opts: { token?: string; sender?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.sender) headers["x-readyfor-sender"] = opts.sender;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const res = await app.request(path, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as any };
}

async function requirementId(surgeryId: string, key: string): Promise<string> {
  const found = (await store.listRequirements(surgeryId)).find((r) => r.key === key);
  if (!found) throw new Error(`no ${key} on ${surgeryId}`);
  return found.id;
}

describe("authentication", () => {
  test("health stays public and reports auth mode", async () => {
    const r = await call("GET", "/health");
    expect(r.status).toBe(200);
    expect(r.json.auth).toBe("neon");
  });

  test("readiness probe stays public", async () => {
    const r = await call("GET", "/ready");
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, database: "memory" });
  });

  test("anonymous reads and writes get 401", async () => {
    expect((await call("GET", "/surgeries")).status).toBe(401);
    expect((await call("POST", "/demo/reset")).status).toBe(401);
    const r = await call("GET", "/outbox");
    expect(r.status).toBe(401);
    expect(r.json.error.code).toBe("unauthorized");
  });

  test("an invalid token gets 401", async () => {
    expect((await call("GET", "/surgeries", { token: "forged" })).status).toBe(401);
  });

  test("a valid account that is not on the allowlist gets 403", async () => {
    const r = await call("GET", "/surgeries", { token: "jwt:user-eve:eve@example.edu:1" });
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe("forbidden");
  });

  test("an allowlisted email only matches once it is verified", async () => {
    expect((await call("GET", "/surgeries", { token: "jwt:user-dana:dana@example.edu:0" })).status).toBe(403);
    expect((await call("GET", "/surgeries", { token: DANA })).status).toBe(200);
  });

  test("a user-id entry matches without a verified email", async () => {
    expect((await call("GET", "/surgeries", { token: PRIYA })).status).toBe(200);
  });

  test("/me reports the resolved identity", async () => {
    const r = await call("GET", "/me", { token: PRIYA });
    expect(r.json.actor).toBe("nurse:Priya");
  });
});

describe("staff permissions", () => {
  test("the audit actor comes from the session, not the body", async () => {
    const id = await requirementId("sur_jordan", "transport");
    const r = await call("POST", `/requirements/${id}/actions`, {
      token: DANA,
      body: { action: "verify", actor: "surgeon:Impostor" },
    });
    expect(r.status).toBe(200);
    expect(r.json.requirement.verifiedBy).toBe("coordinator:Dana");
  });

  test("a coordinator cannot change a lab requirement; a nurse can", async () => {
    const id = await requirementId("sur_jordan", "preop_labs");
    expect((await call("POST", `/requirements/${id}/actions`, { token: DANA, body: { action: "reopen" } })).status).toBe(403);
    expect((await call("POST", `/requirements/${id}/actions`, { token: PRIYA, body: { action: "reopen" } })).status).toBe(200);
    const r = await call("POST", `/requirements/${id}/actions`, { token: PRIYA, body: { action: "verify" } });
    expect(r.status).toBe(200);
    expect(r.json.requirement.verifiedBy).toBe("nurse:Priya");
  });

  test("staff may not post as the iMessage channel", async () => {
    const r = await call("POST", "/messages/inbound", {
      token: DANA,
      body: { channel: "imessage", phone: "+17345550100", body: "hi" },
    });
    expect(r.status).toBe(403);
    expect((await call("POST", "/messages/inbound", { token: DANA, body: { channel: "simulated", surgeryId: "sur_harriet", body: "hi" } })).status).toBe(200);
  });

  test("demo reset and the outbox are admin-only", async () => {
    expect((await call("POST", "/demo/reset", { token: DANA })).status).toBe(403);
    expect((await call("GET", "/outbox", { token: DANA })).status).toBe(403);
    expect((await call("POST", "/demo/reset", { token: ROOT })).status).toBe(200);
  });
});

describe("service identities", () => {
  test("the iMessage adapter can use the outbox and inbound, nothing else", async () => {
    expect((await call("GET", "/outbox", { token: IMESSAGE_TOKEN })).status).toBe(200);
    expect((await call("POST", "/messages/inbound", { token: IMESSAGE_TOKEN, body: { channel: "imessage", phone: "+17345550100", body: "hi" } })).status).toBe(200);
    expect((await call("GET", "/surgeries", { token: IMESSAGE_TOKEN })).status).toBe(403);
    expect((await call("POST", "/messages/inbound", { token: IMESSAGE_TOKEN, body: { channel: "simulated", surgeryId: "sur_harriet", body: "hi" } })).status).toBe(403);
  });

  test("the agent does nothing for an unlinked ASI:One sender", async () => {
    expect((await call("GET", "/surgeries", { token: AGENT_TOKEN })).status).toBe(403);
    expect((await call("GET", "/surgeries", { token: AGENT_TOKEN, sender: "agent1stranger" })).status).toBe(403);
  });

  test("the agent acts for a linked sender within that person's role", async () => {
    expect((await call("GET", "/surgeries", { token: AGENT_TOKEN, sender: "agent1cole" })).status).toBe(200);
    const labs = await requirementId("sur_jordan", "preop_labs");
    // Cole is a coordinator, so the agent cannot change labs for him.
    expect((await call("POST", `/requirements/${labs}/actions`, { token: AGENT_TOKEN, sender: "agent1cole", body: { action: "reopen" } })).status).toBe(403);
    const transport = await requirementId("sur_jordan", "transport");
    const r = await call("POST", `/requirements/${transport}/actions`, {
      token: AGENT_TOKEN,
      sender: "agent1priya",
      body: { action: "verify", actor: "coordinator:ASI:One" },
    });
    expect(r.status).toBe(200);
    expect(r.json.requirement.verifiedBy).toBe("nurse:Priya via ASI:One");
  });

  test("the agent cannot reset the demo or read the outbox", async () => {
    expect((await call("POST", "/demo/reset", { token: AGENT_TOKEN, sender: "agent1priya" })).status).toBe(403);
    expect((await call("GET", "/outbox", { token: AGENT_TOKEN, sender: "agent1priya" })).status).toBe(403);
  });
});

describe("configuration", () => {
  test("auth is off without NEON_AUTH_BASE_URL", () => {
    expect(authConfigFromEnv({})).toBeNull();
  });

  test("AUTH_REQUIRED refuses to start without Neon Auth", () => {
    expect(() => authConfigFromEnv({ AUTH_REQUIRED: "1" })).toThrow(/NEON_AUTH_BASE_URL/);
  });

  test("an empty allowlist, a bad role and a short service token are rejected", () => {
    const base = { NEON_AUTH_BASE_URL: "https://ep-test.neonauth.example/neondb/auth" };
    expect(() => authConfigFromEnv(base)).toThrow(/STAFF_ALLOWLIST/);
    expect(() => parseStaffAllowlist("x@example.edu,janitor,X")).toThrow(/role/);
    expect(() => authConfigFromEnv({ ...base, STAFF_ALLOWLIST: "x@example.edu,admin,X", AGENT_SERVICE_TOKEN: "short" })).toThrow(/32/);
  });

  test("CORS allows only the configured dashboard origin", async () => {
    const res = await app.request("/surgeries", { method: "OPTIONS", headers: { origin: "https://evil.example", "access-control-request-method": "GET" } });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    const ok = await app.request("/surgeries", { method: "OPTIONS", headers: { origin: "http://localhost:4173", "access-control-request-method": "GET" } });
    expect(ok.headers.get("access-control-allow-origin")).toBe("http://localhost:4173");
  });
});
