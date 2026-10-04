/** ReadyFor core service. Wires the store, record check, conversation handler and HTTP app. */
import seedJson from "../../db/seed/demo.json" with { type: "json" };
import { authConfigFromEnv } from "./auth/auth.ts";
import { createFixtureClassifier, createFixtureSource } from "./clinical/fixtures/fixtures.ts";
import { createFinchNodeSource } from "./clinical/finchnode.ts";
import { createRecordCheck } from "./clinical/recordCheck.ts";
import { createRxClassClassifier } from "./clinical/rxclass.ts";
import { createInboundHandler } from "./conversation/inbound.ts";
import { createApp } from "./http/app.ts";
import { createLlm } from "./llm/index.ts";
import { openStore } from "./store/open.ts";
import type { AppDeps, RecordSource, SeedData } from "./types.ts";

const env = process.env;
const seed = seedJson as SeedData;
const clock = { now: () => new Date() };
const clinic = {
  name: env.CLINIC_NAME || "Northstar Surgical Center",
  phone: env.CLINIC_PHONE || "(734) 555-0100",
};

const useFixtures = env.RECORD_FIXTURES === "1";
const liveRecords = useFixtures ? createFixtureSource() : createFinchNodeSource();
// A health-record failure becomes a 502 with a readable message, not a 500.
const records: RecordSource = {
  async getRecord(subject) {
    try {
      return await liveRecords.getRecord(subject);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw Object.assign(new Error(`Could not read the health record: ${message}`), { code: "upstream_failed" });
    }
  },
};
const classifier = useFixtures ? createFixtureClassifier() : createRxClassClassifier();

const { store, database } = await openStore(env);
const llm = createLlm({ GEMINI_API_KEY: env.GEMINI_API_KEY, GEMINI_MODEL: env.GEMINI_MODEL, GEMINI_FALLBACK_MODELS: env.GEMINI_FALLBACK_MODELS });

// The in-memory database starts empty every run. A real database is seeded only when it has no surgeries.
if (database === "memory" || (await store.listSurgeries()).length === 0) {
  await store.reset(seed, clock.now());
}

// Auth is on when NEON_AUTH_BASE_URL is set. With auth on, CORS defaults to the local dashboard only.
const auth = authConfigFromEnv(env);
const corsOrigins = env.CORS_ORIGINS?.trim()
  ? env.CORS_ORIGINS.split(",").map((o) => o.trim().replace(/\/+$/, "")).filter(Boolean)
  : auth
    ? ["http://localhost:4173"]
    : undefined;

const deps: AppDeps = {
  store,
  clock,
  clinic,
  runRecordCheck: createRecordCheck({ store, records, classifier, clock, clinic }),
  handleInbound: createInboundHandler({ store, llm, clock, clinic }),
  seed: () => seed,
  info: { llm: llm.name, database, records: useFixtures ? "fixtures" : "live" },
  auth,
  corsOrigins,
};

const port = Number(env.CORE_PORT || 8787);
Bun.serve({ port, fetch: createApp(deps).fetch, maxRequestBodySize: 32 * 1024 * 1024 });
console.log(`ReadyFor core on http://localhost:${port}  (llm: ${llm.name}, database: ${database}, records: ${deps.info.records}, auth: ${auth ? "neon" : "off"})`);
if (!auth) console.warn("Auth is off: anyone who can reach this port can read and change demo data. Set NEON_AUTH_BASE_URL to turn it on.");
