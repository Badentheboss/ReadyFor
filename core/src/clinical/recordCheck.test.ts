import { beforeEach, describe, expect, test } from "bun:test";
import type { HealthRecord, RecordSource, Requirement, SeedData, Store } from "../types.ts";
import { createFixtureClassifier, createFixtureSource } from "./fixtures/fixtures.ts";
import { createRecordCheck } from "./recordCheck.ts";
import { createRxClassClassifier } from "./rxclass.ts";
import { createMemoryStore } from "./testing/memoryStore.ts";

const NOW = new Date("2026-10-03T20:00:00Z");
const clock = { now: () => NOW };
const clinic = { name: "Northstar Surgical Center", phone: "(734) 555-0100" };

const seed: SeedData = {
  patients: [
    { id: "pat_harriet", finchnodeSubject: "patient-demo-polypharmacy", displayName: "Harriet Lindqvist", phone: "+17345550100", birthDate: "1948-03-02" },
    { id: "pat_nosubject", finchnodeSubject: null, displayName: "No Subject", phone: null, birthDate: null },
  ],
  surgeries: [
    // 5 days after NOW at 12:30 UTC = 2026-10-08T12:30:00Z
    { id: "sur_harriet", patientId: "pat_harriet", procedureCode: "TKA", procedureName: "Total knee replacement (right)", daysFromNow: 5, timeOfDay: "12:30", location: "OR 3", surgeon: "Dr. Avery Demo" },
    { id: "sur_nosubject", patientId: "pat_nosubject", procedureCode: "TKA", procedureName: "Total knee replacement (left)", daysFromNow: 5, timeOfDay: "12:30", location: "OR 1", surgeon: "Dr. Avery Demo" },
  ],
};

async function setup(opts: { records?: RecordSource; classifier?: ReturnType<typeof createFixtureClassifier> } = {}) {
  const store = createMemoryStore(clock.now);
  await store.reset(seed, NOW);
  const run = createRecordCheck({
    store,
    records: opts.records ?? createFixtureSource(),
    classifier: opts.classifier ?? createFixtureClassifier(),
    clock,
    clinic,
  });
  return { store, run };
}

async function byKey(store: Store, surgeryId = "sur_harriet") {
  const rows = await store.listRequirements(surgeryId);
  return Object.fromEntries(rows.map((r) => [r.key, r])) as Record<string, Requirement | undefined>;
}

/** Harriet's record with changes applied, served through the same source interface. */
function recordWith(change: (r: HealthRecord) => void): RecordSource {
  const base = createFixtureSource();
  return {
    async getRecord(subject) {
      const r = await base.getRecord(subject);
      change(r);
      return r;
    },
  };
}

describe("Harriet", () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    ctx = await setup();
  });

  test("first check produces exactly the expected requirements", async () => {
    const result = await ctx.run("sur_harriet");
    expect(result.created).toEqual(["preop_labs", "a1c_recent", "anticoagulant_plan", "antiplatelet_plan", "diabetes_med_plan", "transport", "fasting_ack"]);
    expect(result.changed).toEqual([]);
    expect(result.warnings).toEqual([]);

    const rows = await byKey(ctx.store);
    expect(Object.keys(rows).sort()).toEqual(["a1c_recent", "anticoagulant_plan", "antiplatelet_plan", "diabetes_med_plan", "fasting_ack", "preop_labs", "transport"]);

    const labs = rows.preop_labs!;
    expect([labs.status, labs.blocking, labs.owner, labs.kind]).toEqual(["open", true, "nurse", "lab"]);
    expect(labs.reason).toBe("The newest blood work is from 2026-07-14, 86 days before surgery.");
    expect(labs.source?.system).toBe("finchnode");

    const a1c = rows.a1c_recent!;
    expect([a1c.status, a1c.blocking]).toEqual(["satisfied", false]);
    expect(a1c.reason).toContain("86 days before surgery");

    const ac = rows.anticoagulant_plan!;
    expect([ac.status, ac.blocking, ac.owner]).toEqual(["open", true, "surgeon"]);
    expect(ac.reason).toBe("Apixaban is an anticoagulant and no pause plan is on file.");
    expect(ac.source).toEqual({
      system: "rxclass",
      detail: "Apixaban 5 MG Oral Tablet is ATC B01AF (Direct factor Xa inhibitors)",
      data: { rxcui: "1364445", classId: "B01AF", className: "Direct factor Xa inhibitors", lookup: "rxclass" },
    });
    expect(ac.proposal?.templateKey).toBe("anticoagulant_pause");
    expect(ac.proposal?.drugName).toBe("Apixaban 5 MG Oral Tablet");
    expect(ac.proposal?.text).toContain("your blood thinner (apixaban)");
    expect(ac.proposal?.text).toContain("Hi Harriet,");
    expect(ac.proposal?.text).toContain("{{staff_instruction}}");

    const ap = rows.antiplatelet_plan!;
    expect([ap.status, ap.blocking]).toEqual(["open", false]);
    expect(ap.source?.detail).toContain("Aspirin 81 MG Oral Tablet is ATC B01AC");
    expect(ap.proposal?.text).toContain("aspirin");

    const dm = rows.diabetes_med_plan!;
    expect([dm.status, dm.blocking]).toEqual(["open", false]);
    expect(dm.source?.detail).toContain("A10BA (Biguanides)");
    expect(dm.proposal?.text).toContain("metformin");

    expect(rows.transport?.status).toBe("open");
    expect(rows.transport?.reason).toBe("The patient has not confirmed who will drive them home.");
    expect(rows.transport?.source?.system).toBe("rule");
    expect(rows.fasting_ack?.status).toBe("open");
    expect(rows.fasting_ack?.reason).toBe("Fasting instructions have not been sent yet.");
    expect(rows.fasting_ack?.blocking).toBe(false);
  });

  test("queues exactly one labs message and records events", async () => {
    const result = await ctx.run("sur_harriet");
    expect(result.outbound.length).toBe(1);
    const m = result.outbound[0]!;
    expect([m.direction, m.channel, m.deliveryStatus]).toEqual(["out", "imessage", "queued"]);
    expect(m.body).toContain("last 30 days");
    expect((await ctx.store.listOutbox("imessage")).length).toBe(1);

    const events = await ctx.store.listEvents("sur_harriet");
    const sent = events.filter((e) => e.type === "outreach_sent");
    expect(sent.length).toBe(1);
    expect(sent[0]?.data?.key).toBe("preop_labs");

    const ran = events.find((e) => e.type === "check_ran")!;
    expect(ran.actor).toBe("agent");
    expect(ran.summary).toBe("Record check: 3 blockers found (blood thinner plan, pre-op blood work, ride home).");
    const flagged = events.filter((e) => e.type === "requirement_flagged").map((e) => e.data?.key);
    expect(flagged.sort()).toEqual(["anticoagulant_plan", "preop_labs", "transport"]);
    expect((await ctx.store.getSurgery("sur_harriet"))?.lastCheckedAt).toBe(NOW.toISOString());
    expect((await ctx.store.getSurgery("sur_harriet"))?.scheduledAt).toBe("2026-10-08T12:30:00.000Z");
  });

  test("re-running changes nothing and sends nothing", async () => {
    await ctx.run("sur_harriet");
    const before = JSON.stringify(await ctx.store.listRequirements("sur_harriet"));
    const second = await ctx.run("sur_harriet");
    expect(second.created).toEqual([]);
    expect(second.changed).toEqual([]);
    expect(second.outbound).toEqual([]);
    expect(JSON.stringify(await ctx.store.listRequirements("sur_harriet"))).toBe(before);
    expect((await ctx.store.listMessages("sur_harriet")).length).toBe(1);
    const events = await ctx.store.listEvents("sur_harriet");
    expect(events.filter((e) => e.type === "requirement_flagged").length).toBe(3);
    expect(events.filter((e) => e.type === "check_ran").length).toBe(2);
  });

  test("never touches evidence_received, verified or waived rows", async () => {
    await ctx.run("sur_harriet");
    const rows = await byKey(ctx.store);
    await ctx.store.updateRequirement(rows.preop_labs!.id, { status: "evidence_received", reason: "Patient sent a lab report." });
    await ctx.store.updateRequirement(rows.anticoagulant_plan!.id, { status: "verified", verifiedBy: "nurse:Priya", reason: "Plan approved." });
    await ctx.store.updateRequirement(rows.antiplatelet_plan!.id, { status: "waived", staffNote: "Not needed", reason: "Waived." });
    const before = JSON.stringify(await ctx.store.listRequirements("sur_harriet"));
    const result = await ctx.run("sur_harriet");
    expect(result.created).toEqual([]);
    expect(result.changed).toEqual([]);
    expect(JSON.stringify(await ctx.store.listRequirements("sur_harriet"))).toBe(before);
    // Labs are no longer waiting on the patient, so the next question (the ride) goes out once.
    expect(result.outbound.length).toBe(1);
    expect(result.outbound[0]?.body).toContain("who will be driving you home");
    expect((await ctx.run("sur_harriet")).outbound).toEqual([]);
  });

  test("does not overwrite a reason another module set on transport", async () => {
    await ctx.run("sur_harriet");
    const rows = await byKey(ctx.store);
    await ctx.store.updateRequirement(rows.transport!.id, { reason: "The patient says nobody can drive them." });
    const result = await ctx.run("sur_harriet");
    expect(result.changed).toEqual([]);
    expect((await byKey(ctx.store)).transport?.reason).toBe("The patient says nobody can drive them.");
  });
});

describe("changes in the record", () => {
  test("fresh labs make preop_labs satisfied and move the question to transport", async () => {
    const records = recordWith((r) => {
      for (const name of ["Hemoglobin [Mass/volume] in Blood", "Platelets [#/volume] in Blood", "Creatinine [Mass/volume] in Serum or Plasma", "Potassium [Moles/volume] in Serum or Plasma"]) {
        r.labs.push({ name, value: "1", unit: null, date: "2026-09-29T10:00:00Z" });
      }
    });
    const { store, run } = await setup({ records });
    const result = await run("sur_harriet");
    const rows = await byKey(store);
    expect(rows.preop_labs?.status).toBe("satisfied");
    expect(rows.preop_labs?.reason).toBe("Blood work from 2026-09-29 is on file, within 30 days before surgery.");
    expect(result.created).toContain("preop_labs");
    expect(result.outbound.length).toBe(1);
    expect(result.outbound[0]?.body).toContain("who will be driving you home");
    const flagged = (await store.listEvents("sur_harriet")).filter((e) => e.type === "requirement_flagged").map((e) => e.data?.key);
    expect(flagged).not.toContain("preop_labs");
    // A second run does not ask again.
    expect((await run("sur_harriet")).outbound).toEqual([]);
  });

  test("an open labs row turns satisfied when labs arrive between runs, and is reported as changed", async () => {
    let fresh = false;
    const records = recordWith((r) => {
      if (!fresh) return;
      for (const name of ["Hgb", "Platelets", "Creatinine", "Potassium"]) r.labs.push({ name, value: "1", unit: null, date: "2026-10-01T10:00:00Z" });
    });
    const { store, run } = await setup({ records });
    await run("sur_harriet");
    fresh = true;
    const second = await run("sur_harriet");
    expect(second.changed).toEqual(["preop_labs"]);
    expect((await byKey(store)).preop_labs?.status).toBe("satisfied");
  });

  test("partial fresh labs name what is missing", async () => {
    const records = recordWith((r) => {
      r.labs.push({ name: "Hemoglobin", value: "12", unit: "g/dL", date: "2026-09-29T10:00:00Z" });
    });
    const { store, run } = await setup({ records });
    await run("sur_harriet");
    const labs = (await byKey(store)).preop_labs!;
    expect(labs.status).toBe("open");
    expect(labs.reason).toBe("Blood work from 2026-09-29 is on file, but there is no recent platelets, creatinine and potassium result.");
  });

  test("labs dated after surgery do not count", async () => {
    const records = recordWith((r) => {
      r.labs = [{ name: "Hemoglobin", value: "12", unit: null, date: "2026-10-20T10:00:00Z" }];
    });
    const { store, run } = await setup({ records });
    await run("sur_harriet");
    expect((await byKey(store)).preop_labs?.reason).toBe("No blood work is on file.");
  });

  test("a stopped medication is ignored and a vanished one becomes satisfied", async () => {
    let stopApixaban = false;
    const records = recordWith((r) => {
      if (stopApixaban) r.medications = r.medications.map((m) => (m.name.startsWith("apixaban") ? { ...m, status: "stopped" } : m));
      r.medications.push({ name: "warfarin 5 MG Oral Tablet", status: "stopped", rxcui: null, startDate: null });
    });
    const { store, run } = await setup({ records });
    await run("sur_harriet");
    expect((await byKey(store)).anticoagulant_plan?.reason).toBe("Apixaban is an anticoagulant and no pause plan is on file.");
    stopApixaban = true;
    const second = await run("sur_harriet");
    expect(second.changed).toEqual(["anticoagulant_plan"]);
    const ac = (await byKey(store)).anticoagulant_plan!;
    expect(ac.status).toBe("satisfied");
    expect(ac.reason).toStartWith("No longer applies:");
    // And it is not deleted or flipped again on the next run.
    expect((await run("sur_harriet")).changed).toEqual([]);
  });

  test("two anticoagulants are both named, the first drives the proposal", async () => {
    const records = recordWith((r) => {
      r.medications.push({ name: "warfarin 5 MG Oral Tablet", status: "active", rxcui: null, startDate: null });
    });
    // The built-in table knows both drugs; the fixture RxClass answers only know apixaban.
    const down = createRxClassClassifier({ fetch: (async () => { throw new TypeError("down"); }) as unknown as typeof fetch });
    const { store, run } = await setup({ records, classifier: down });
    await run("sur_harriet");
    const ac = (await byKey(store)).anticoagulant_plan!;
    expect(ac.reason).toBe("Apixaban and Warfarin are anticoagulants and no pause plan is on file.");
    expect(ac.source?.detail).toContain("Apixaban 5 MG Oral Tablet is ATC B01AF");
    expect(ac.source?.detail).toContain("Warfarin 5 MG Oral Tablet is ATC B01AA");
    expect(ac.proposal?.drugName).toBe("Apixaban 5 MG Oral Tablet");
    expect(Array.isArray(ac.source?.data?.medications)).toBe(true);
  });
});

describe("RxClass failure", () => {
  test("falls back to the built-in table with a warning", async () => {
    const down = createRxClassClassifier({ fetch: (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch });
    const { store, run } = await setup({ classifier: down });
    const result = await run("sur_harriet");
    expect(result.warnings).toEqual(["RxClass was unreachable; drug classes came from the built-in table."]);
    const rows = await byKey(store);
    expect(rows.anticoagulant_plan?.status).toBe("open");
    expect(rows.anticoagulant_plan?.source?.detail).toBe("Apixaban 5 MG Oral Tablet is ATC B01AF (Direct factor Xa inhibitors) (built-in drug table; RxClass was unreachable)");
    expect(rows.anticoagulant_plan?.source?.data).toEqual({ rxcui: "1364445", classId: "B01AF", className: "Direct factor Xa inhibitors", lookup: "local_fallback" });
    expect(rows.antiplatelet_plan?.status).toBe("open");
    expect(rows.diabetes_med_plan?.status).toBe("open");
  });
});

describe("sparse and malformed records", () => {
  const sparse: RecordSource = {
    async getRecord(subject) {
      return { subject, patientName: null, birthDate: null, medications: [], conditions: [], labs: [], dataAsOf: null, synthetic: true, sourceNames: [] };
    },
  };

  test("no medications and no labs still gets labs, transport and fasting", async () => {
    const { store, run } = await setup({ records: sparse });
    const result = await run("sur_harriet");
    expect(result.created).toEqual(["preop_labs", "transport", "fasting_ack"]);
    const rows = await byKey(store);
    expect(rows.preop_labs?.reason).toBe("No blood work is on file.");
    expect(result.outbound.length).toBe(1);
    const ran = (await store.listEvents("sur_harriet")).find((e) => e.type === "check_ran")!;
    expect(ran.summary).toBe("Record check: 2 blockers found (pre-op blood work, ride home).");
  });

  test("malformed items from the live source do not throw", async () => {
    const weird = {
      id: "patient-demo-polypharmacy",
      data: {
        medications: [null, 7, { name: "Free text with no code", status: "active" }, { name: "apixaban 5 MG Oral Tablet", status: "active", codes: [{ system: "rxnorm", code: 1364445 }] }],
        conditions: [{ name: "Type 2 diabetes mellitus", status: "active" }, "junk"],
        labs: [{ name: "Hemoglobin A1c", value: null, date: "2026-09-01T00:00:00Z" }, { name: "Platelets" }, null],
      },
    };
    const { createFinchNodeSource } = await import("./finchnode.ts");
    const records = createFinchNodeSource({ fetch: (async () => new Response(JSON.stringify(weird), { status: 200 })) as unknown as typeof fetch });
    const { store, run } = await setup({ records });
    const result = await run("sur_harriet");
    expect(result.created).toContain("a1c_recent");
    const rows = await byKey(store);
    expect(rows.a1c_recent?.status).toBe("open");
    expect(rows.a1c_recent?.reason).toBe("No A1c is on file.");
    expect(rows.anticoagulant_plan?.status).toBe("open");
  });
});

describe("failures", () => {
  test("unknown surgery is not_found", async () => {
    const { run } = await setup();
    await expect(run("sur_nope")).rejects.toThrow("not_found");
  });

  test("patient without a FinchNode subject gives a clear error", async () => {
    const { run } = await setup();
    await expect(run("sur_nosubject")).rejects.toThrow(/no FinchNode subject/);
  });

  test("record source errors propagate", async () => {
    const records: RecordSource = { async getRecord() { throw new Error("FinchNode request failed with HTTP 503"); } };
    const { run, store } = await setup({ records });
    await expect(run("sur_harriet")).rejects.toThrow("503");
    expect(await store.listRequirements("sur_harriet")).toEqual([]);
  });
});
