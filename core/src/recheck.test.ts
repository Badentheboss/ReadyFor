import { beforeEach, describe, expect, test } from "bun:test";
import { createFixtureClassifier, createFixtureSource } from "./clinical/fixtures/fixtures.ts";
import { createRecordCheck } from "./clinical/recordCheck.ts";
import { createMemoryStore } from "./clinical/testing/memoryStore.ts";
import { createRechecker } from "./recheck.ts";
import type { HealthRecord, RecordSource, SeedData, Store } from "./types.ts";

const HOUR = 3_600_000;
const seed: SeedData = {
  patients: [{ id: "pat_harriet", finchnodeSubject: "patient-demo-polypharmacy", displayName: "Harriet Lindqvist", phone: "+17345550100", birthDate: "1948-03-02" }],
  surgeries: [
    { id: "sur_harriet", patientId: "pat_harriet", procedureCode: "TKA", procedureName: "Total knee replacement (right)", daysFromNow: 5, timeOfDay: "12:30", location: "OR 3", surgeon: "Dr. Avery Demo" },
  ],
};

let now: Date;
let store: Store;
let record: (r: HealthRecord) => void;
let recheck: ReturnType<typeof createRechecker>;
let runCheck: ReturnType<typeof createRecordCheck>;

beforeEach(async () => {
  now = new Date("2026-10-03T20:00:00Z");
  const clock = { now: () => now };
  store = createMemoryStore(clock.now);
  await store.reset(seed, now);
  record = () => {};
  const base = createFixtureSource();
  const records: RecordSource = { async getRecord(subject) { const r = await base.getRecord(subject); record(r); return r; } };
  runCheck = createRecordCheck({ store, records, classifier: createFixtureClassifier(), clock, clinic: { name: "Northstar", phone: "(734) 555-0100" } });
  recheck = createRechecker({ store, runRecordCheck: runCheck, clock, recheckAfterMs: 24 * HOUR });
});

const req = async (key: string) => (await store.listRequirements("sur_harriet")).find((r) => r.key === key)!;
const openTasks = async () => (await store.listTasks("sur_harriet")).filter((t) => t.status === "open").map((t) => t.title).sort();
const withoutApixaban = (r: HealthRecord) => { r.medications = r.medications.filter((m) => !/apixaban/i.test(m.name)); };

describe("scheduled recheck", () => {
  test("never-checked surgeries are left alone, and a recent check is not repeated", async () => {
    expect((await recheck.runOnce()).checked).toEqual([]);
    await runCheck("sur_harriet");
    now = new Date(now.getTime() + 2 * HOUR);
    expect((await recheck.runOnce()).checked).toEqual([]);
    expect((await recheck.runOnce({ force: true })).checked).toEqual(["sur_harriet"]);
  });

  test("a new blocker after 24 hours becomes one staff task, and retries add nothing", async () => {
    record = withoutApixaban;
    await runCheck("sur_harriet");
    const messagesBefore = (await store.listMessages("sur_harriet")).length;
    const tasksBefore = await openTasks();

    record = () => {};
    now = new Date(now.getTime() + 25 * HOUR);
    const first = await recheck.runOnce();
    expect(first.findings).toEqual([{ surgeryId: "sur_harriet", key: "anticoagulant_plan", kind: "new" }]);
    expect(await openTasks()).toEqual([...tasksBefore, "Recheck: Blood thinner plan"].sort());
    expect((await store.listEvents("sur_harriet"))[0]!.type).toBe("recheck_findings");

    const again = await recheck.runOnce({ force: true });
    expect(again.findings).toEqual([]);
    expect(await openTasks()).toEqual([...tasksBefore, "Recheck: Blood thinner plan"].sort());
    expect((await store.listMessages("sur_harriet")).length).toBe(messagesBefore);
  });

  test("a record change under a verified decision asks for re-review without undoing it", async () => {
    await runCheck("sur_harriet");
    const plan = await req("anticoagulant_plan");
    await store.updateRequirement(plan.id, { status: "verified", verifiedBy: "surgeon:Avery", reason: "Plan approved." });

    record = (r) => { for (const m of r.medications) if (/apixaban/i.test(m.name)) m.name = "apixaban 2.5 MG Oral Tablet"; };
    const summary = await recheck.runOnce({ force: true });
    expect(summary.findings).toContainEqual({ surgeryId: "sur_harriet", key: "anticoagulant_plan", kind: "record_changed" });
    const after = await req("anticoagulant_plan");
    expect(after.status).toBe("verified");
    expect(after.verifiedBy).toBe("surgeon:Avery");
    expect(await openTasks()).toContain("Re-review: Blood thinner plan");
    expect((await store.listEvents("sur_harriet")).some((e) => e.type === "requirement_needs_review")).toBe(true);

    const again = await recheck.runOnce({ force: true });
    expect(again.findings.filter((f) => f.kind === "record_changed")).toEqual([]);
    expect((await openTasks()).filter((t) => t === "Re-review: Blood thinner plan")).toHaveLength(1);
  });

  test("verified lab evidence that is too old for the surgery date is flagged once", async () => {
    await runCheck("sur_harriet");
    const labs = await req("preop_labs");
    await store.updateRequirement(labs.id, {
      status: "verified",
      evidence: { type: "document", summary: "Outside lab report", data: { collectedDate: "2026-08-01" } },
    });
    const first = await recheck.runOnce();
    expect(first.findings).toEqual([{ surgeryId: "sur_harriet", key: "preop_labs", kind: "evidence_stale" }]);
    expect(await openTasks()).toContain("Re-review: Pre-op blood work within 30 days");
    expect((await recheck.runOnce()).findings).toEqual([]);

    await store.updateRequirement(labs.id, { evidence: { type: "document", summary: "Newer report", data: { collectedDate: "2026-09-29" } } });
    expect((await recheck.runOnce()).findings).toEqual([]);
  });
});
