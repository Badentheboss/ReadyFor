import type {
  HealthRecord,
  IsoDate,
  IsoDateTime,
  RecordCondition,
  RecordLab,
  RecordMedication,
  RecordSource,
} from "../types.ts";

const DEFAULT_BASE_URL = "https://api.finchnode.com/demo/v1";
const MAX_RETRY_WAIT_MS = 10_000;

type Obj = Record<string, unknown>;

export interface FinchNodeOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Override the wait used for a 429 retry (tests). */
  sleep?: (ms: number) => Promise<void>;
}

export function createFinchNodeSource(opts: FinchNodeOptions = {}): RecordSource {
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const doFetch = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  return {
    async getRecord(subject: string): Promise<HealthRecord> {
      const url = `${baseUrl}/users/${encodeURIComponent(subject)}/records?categories=demographics,medications,conditions,labs`;
      let res = await doFetch(url, { headers: { accept: "application/json" } });
      if (res.status === 429) {
        await sleep(retryAfterMs(res.headers.get("retry-after")));
        res = await doFetch(url, { headers: { accept: "application/json" } });
      }
      if (!res.ok) throw new Error(`FinchNode request failed with HTTP ${res.status} for subject ${subject}`);
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        throw new Error(`FinchNode returned a response that is not JSON for subject ${subject}`);
      }
      return normaliseRecord(subject, body);
    },
  };
}

function retryAfterMs(header: string | null): number {
  if (!header) return 1000;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.min(Math.max(seconds, 0) * 1000, MAX_RETRY_WAIT_MS);
  const at = Date.parse(header);
  if (Number.isFinite(at)) return Math.min(Math.max(at - Date.now(), 0), MAX_RETRY_WAIT_MS);
  return 1000;
}

// ---------------------------------------------------------------------------
// Normalisation. Every helper tolerates missing, null or oddly typed input.
// ---------------------------------------------------------------------------

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  if (typeof v === "string") {
    const t = v.trim();
    return t === "" ? null : t;
  }
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

function list(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function isoDate(v: unknown): IsoDate | null {
  const s = str(v);
  if (!s || !/^\d{4}-\d{2}-\d{2}/.test(s)) return null;
  return s.slice(0, 10);
}

function isoDateTime(v: unknown): IsoDateTime | null {
  const s = str(v);
  if (!s || !/^\d{4}-\d{2}-\d{2}/.test(s) || Number.isNaN(Date.parse(s))) return null;
  return s;
}

function codes(item: Obj): Obj[] {
  return list(item.codes).filter(isObj);
}

function itemName(item: Obj): string | null {
  const name = str(item.name);
  if (name) return name;
  for (const c of codes(item)) {
    const d = str(c.display);
    if (d) return d;
  }
  return null;
}

function rxcuiOf(item: Obj): string | null {
  for (const c of codes(item)) {
    const system = str(c.system);
    if (system && system.toLowerCase().includes("rxnorm")) {
      const code = str(c.code);
      if (code) return code;
    }
  }
  return null;
}

function medication(item: unknown): RecordMedication | null {
  if (!isObj(item)) return null;
  const name = itemName(item);
  if (!name) return null;
  return {
    name,
    status: (str(item.status) ?? "unknown").toLowerCase(),
    rxcui: rxcuiOf(item),
    startDate: isoDate(item.startDate),
  };
}

function condition(item: unknown): RecordCondition | null {
  if (!isObj(item)) return null;
  const name = itemName(item);
  if (!name) return null;
  return { name, status: (str(item.status) ?? "unknown").toLowerCase() };
}

function lab(item: unknown): RecordLab | null {
  if (!isObj(item)) return null;
  const name = itemName(item);
  if (!name) return null;
  return {
    name,
    value: str(item.value),
    unit: str(item.unit),
    date: isoDateTime(item.date),
  };
}

function compact<T>(items: unknown[], fn: (x: unknown) => T | null): T[] {
  const out: T[] = [];
  for (const item of items) {
    try {
      const v = fn(item);
      if (v) out.push(v);
    } catch {
      // A strange item is dropped, never fatal.
    }
  }
  return out;
}

export function normaliseRecord(subject: string, body: unknown): HealthRecord {
  const root = isObj(body) ? body : {};
  const data = isObj(root.data) ? root.data : {};
  const meta = isObj(root.meta) ? root.meta : {};

  const demographics = Array.isArray(data.demographics) ? data.demographics[0] : data.demographics;
  const demo = isObj(demographics) ? demographics : {};

  const sourceNames: string[] = [];
  for (const s of list(root.sources)) {
    const name = isObj(s) ? (str(s.organization) ?? str(s.name) ?? str(s.sourceName) ?? str(s.system)) : typeof s === "string" ? str(s) : null;
    if (name && !sourceNames.includes(name)) sourceNames.push(name);
  }

  return {
    subject: str(root.id) ?? subject,
    patientName: str(demo.name),
    birthDate: isoDate(demo.birthDate),
    medications: compact(list(data.medications), medication),
    conditions: compact(list(data.conditions), condition),
    labs: compact(list(data.labs), lab),
    dataAsOf: isoDateTime(meta.dataAsOf),
    synthetic: root.synthetic === true,
    sourceNames,
  };
}
