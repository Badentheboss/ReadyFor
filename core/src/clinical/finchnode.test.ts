import { describe, expect, test } from "bun:test";
import { createFinchNodeSource } from "./finchnode.ts";
import { createFixtureSource } from "./fixtures/fixtures.ts";
import harriet from "./fixtures/harriet.record.json" with { type: "json" };

function jsonFetch(body: unknown, init: ResponseInit = { status: 200 }) {
  const calls: string[] = [];
  const fn = (async (input: string | URL | Request) => {
    calls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    return new Response(JSON.stringify(body), init);
  }) as typeof fetch;
  return { fn, calls };
}

describe("createFinchNodeSource", () => {
  test("requests the right URL and normalises Harriet", async () => {
    const { fn, calls } = jsonFetch(harriet);
    const record = await createFinchNodeSource({ fetch: fn }).getRecord("patient-demo-polypharmacy");
    expect(calls).toEqual([
      "https://api.finchnode.com/demo/v1/users/patient-demo-polypharmacy/records?categories=demographics,medications,conditions,labs",
    ]);
    expect(record.subject).toBe("patient-demo-polypharmacy");
    expect(record.patientName).toBe("Harriet Lindqvist");
    expect(record.birthDate).toBe("1948-03-02");
    expect(record.synthetic).toBe(true);
    expect(record.dataAsOf).toBe("2026-09-01T00:00:00Z");
    expect(record.sourceNames).toEqual(["Northstar Health System (Synthetic)"]);
    expect(record.medications.length).toBe(14);
    expect(record.medications[0]).toEqual({ name: "apixaban 5 MG Oral Tablet", status: "active", rxcui: "1364445", startDate: "2025-08-19" });
    expect(record.conditions.length).toBe(10);
    expect(record.conditions[0]).toEqual({ name: "Chronic kidney disease stage 3", status: "active" });
    const creatinine = record.labs.filter((l) => l.name.startsWith("Creatinine"));
    expect(creatinine.length).toBe(4);
    expect(creatinine.at(-1)).toEqual({ name: "Creatinine [Mass/volume] in Serum or Plasma", value: "1.7", unit: "mg/dL", date: "2026-07-14T15:30:00Z" });
  });

  test("honours a custom base URL", async () => {
    const { fn, calls } = jsonFetch(harriet);
    await createFinchNodeSource({ baseUrl: "http://local/v1/", fetch: fn }).getRecord("a b");
    expect(calls[0]).toStartWith("http://local/v1/users/a%20b/records?");
  });

  test("weird items are skipped or nulled, never thrown", async () => {
    const body = {
      id: "patient-demo-weird",
      synthetic: true,
      sources: [null, "Plain Source", { name: "Named" }, 5],
      meta: { dataAsOf: 12 },
      data: {
        demographics: [],
        medications: [
          null,
          42,
          "aspirin",
          { name: "Free text med, no code", status: "active" },
          { name: null, codes: [{ system: "http://www.nlm.nih.gov/research/umls/rxnorm", code: 861007, display: "metformin 500 MG" }], status: "ACTIVE" },
          { name: "No status", codes: "oops" },
          { name: "Odd start", startDate: { x: 1 }, codes: [null, { system: 5 }] },
          {},
        ],
        conditions: [{ name: "Diabetes" }, { status: "active" }, [], null],
        labs: [
          { name: "Hemoglobin", value: null, date: "2026-07-14T00:00:00Z" },
          { name: "Platelets", value: 198, unit: null },
          { name: "Potassium", value: "4.9", date: "garbage" },
          { value: "1" },
          7,
        ],
      },
    };
    const record = await createFinchNodeSource({ fetch: jsonFetch(body).fn }).getRecord("patient-demo-weird");
    expect(record.patientName).toBeNull();
    expect(record.birthDate).toBeNull();
    expect(record.dataAsOf).toBeNull();
    expect(record.sourceNames).toEqual(["Plain Source", "Named"]);
    expect(record.medications.map((m) => [m.name, m.status, m.rxcui])).toEqual([
      ["Free text med, no code", "active", null],
      ["metformin 500 MG", "active", "861007"],
      ["No status", "unknown", null],
      ["Odd start", "unknown", null],
    ]);
    expect(record.medications[3]?.startDate).toBeNull();
    expect(record.conditions).toEqual([{ name: "Diabetes", status: "unknown" }]);
    expect(record.labs).toEqual([
      { name: "Hemoglobin", value: null, unit: null, date: "2026-07-14T00:00:00Z" },
      { name: "Platelets", value: "198", unit: null, date: null },
      { name: "Potassium", value: "4.9", unit: null, date: null },
    ]);
  });

  test("a body with no data at all gives an empty record", async () => {
    for (const body of [{}, [], "text", null]) {
      const record = await createFinchNodeSource({ fetch: jsonFetch(body).fn }).getRecord("s");
      expect(record.medications).toEqual([]);
      expect(record.subject).toBe("s");
      expect(record.synthetic).toBe(false);
    }
  });

  test("429 waits for Retry-After and retries once", async () => {
    let n = 0;
    const waits: number[] = [];
    const fn = (async () => {
      n++;
      return n === 1
        ? new Response("slow down", { status: 429, headers: { "retry-after": "2" } })
        : new Response(JSON.stringify(harriet), { status: 200 });
    }) as unknown as typeof fetch;
    const source = createFinchNodeSource({ fetch: fn, sleep: async (ms) => void waits.push(ms) });
    const record = await source.getRecord("patient-demo-polypharmacy");
    expect(n).toBe(2);
    expect(waits).toEqual([2000]);
    expect(record.medications.length).toBe(14);
  });

  test("a second 429 throws", async () => {
    let n = 0;
    const fn = (async () => {
      n++;
      return new Response("", { status: 429 });
    }) as unknown as typeof fetch;
    await expect(createFinchNodeSource({ fetch: fn, sleep: async () => {} }).getRecord("x")).rejects.toThrow("429");
    expect(n).toBe(2);
  });

  test("other non-2xx statuses throw with the status", async () => {
    const { fn } = jsonFetch({ error: "nope" }, { status: 404 });
    await expect(createFinchNodeSource({ fetch: fn }).getRecord("missing")).rejects.toThrow("404");
    const { fn: fn2 } = jsonFetch({}, { status: 500 });
    await expect(createFinchNodeSource({ fetch: fn2 }).getRecord("x")).rejects.toThrow("500");
  });

  test("a network error propagates", async () => {
    const fn = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(createFinchNodeSource({ fetch: fn }).getRecord("x")).rejects.toThrow("fetch failed");
  });
});

describe("createFixtureSource", () => {
  test("serves Harriet and rejects other subjects clearly", async () => {
    const source = createFixtureSource();
    expect((await source.getRecord("patient-demo-polypharmacy")).patientName).toBe("Harriet Lindqvist");
    await expect(source.getRecord("patient-demo-001")).rejects.toThrow(/No fixture record for subject "patient-demo-001"/);
    await expect(source.getRecord("toString")).rejects.toThrow(/No fixture record/);
  });
});
