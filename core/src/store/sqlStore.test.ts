import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import seedJson from "../../../db/seed/demo.json";
import type { SeedData, Store } from "../types.ts";
import { NotFoundError } from "./errors.ts";
import { openMemoryStore } from "./open.ts";

const seed = seedJson as SeedData;
const NOW = new Date("2026-10-03T20:00:00.000Z");

let store: Store;

beforeAll(async () => {
  store = await openMemoryStore();
});

beforeEach(async () => {
  delete process.env.DEMO_PATIENT_PHONE;
  await store.reset(seed, NOW);
});

const lab = {
  surgeryId: "sur_harriet",
  key: "preop_labs",
  title: "Pre-op blood work within 30 days",
  kind: "lab" as const,
  status: "open" as const,
  blocking: true,
  owner: "nurse" as const,
  reason: "Old labs.",
};

describe("reset", () => {
  test("loads surgeries soonest first with dates relative to now", async () => {
    const surgeries = await store.listSurgeries();
    expect(surgeries.map((s) => [s.id, s.scheduledAt])).toEqual([
      ["sur_morgan", "2026-10-06T14:00:00.000Z"],
      ["sur_harriet", "2026-10-08T12:30:00.000Z"],
      ["sur_jordan", "2026-10-15T13:00:00.000Z"],
    ]);
    expect(surgeries[0]).toMatchObject({
      patientId: "pat_morgan",
      status: "scheduled",
      lastCheckedAt: null,
      createdAt: NOW.toISOString(),
    });
  });

  test("returns birth dates as plain dates and timestamps as ISO strings", async () => {
    const patient = await store.getPatient("pat_harriet");
    expect(patient).toEqual({
      id: "pat_harriet",
      finchnodeSubject: "patient-demo-polypharmacy",
      displayName: "Harriet Lindqvist",
      phone: null,
      birthDate: "1948-03-02",
      createdAt: NOW.toISOString(),
    });
  });

  test("resolves env: phones, and treats an empty variable as unset", async () => {
    process.env.DEMO_PATIENT_PHONE = "+17345550100";
    await store.reset(seed, NOW);
    expect((await store.getPatient("pat_harriet"))?.phone).toBe("+17345550100");
    process.env.DEMO_PATIENT_PHONE = "";
    await store.reset(seed, NOW);
    expect((await store.getPatient("pat_harriet"))?.phone).toBeNull();
  });

  test("inserts seeded requirements in order, stamping verification", async () => {
    const reqs = await store.listRequirements("sur_morgan");
    expect(reqs.map((r) => r.key)).toEqual(["preop_labs", "diabetes_med_plan", "transport", "fasting_ack"]);
    expect(reqs[0]).toMatchObject({
      status: "verified",
      verifiedBy: "nurse:Priya",
      verifiedAt: NOW.toISOString(),
      staffNote: null,
      source: { system: "staff", detail: "Seeded demo data" },
      proposal: null,
      evidence: null,
    });
    const jordan = await store.listRequirements("sur_jordan");
    expect(jordan.find((r) => r.key === "transport")).toMatchObject({ status: "open", verifiedBy: null });
    expect(await store.listRequirements("sur_harriet")).toEqual([]);
  });

  test("wipes everything that was there before", async () => {
    await store.addEvent({ surgeryId: "sur_harriet", type: "x", summary: "x", actor: "agent" });
    await store.createTask({ surgeryId: "sur_harriet", title: "t", owner: "nurse", origin: "staff" });
    await store.reset(seed, NOW);
    expect(await store.listEvents("sur_harriet")).toEqual([]);
    expect(await store.listTasks("sur_harriet")).toEqual([]);
  });
});

describe("patients and surgeries", () => {
  test("findPatientByPhone matches on digits only", async () => {
    process.env.DEMO_PATIENT_PHONE = "+17345550100";
    await store.reset(seed, NOW);
    for (const form of ["+17345550100", "+1 (734) 555-0100", "1-734-555-0100", "17345550100"]) {
      expect((await store.findPatientByPhone(form))?.id).toBe("pat_harriet");
    }
    expect(await store.findPatientByPhone("+17345550199")).toBeNull();
    expect(await store.findPatientByPhone("no digits")).toBeNull();
  });

  test("nextSurgeryForPatient ignores past and cancelled surgeries", async () => {
    expect((await store.nextSurgeryForPatient("pat_harriet", NOW))?.id).toBe("sur_harriet");
    expect(await store.nextSurgeryForPatient("pat_harriet", new Date("2026-10-09T00:00:00Z"))).toBeNull();
    await store.updateSurgery("sur_harriet", { status: "cancelled" });
    expect(await store.nextSurgeryForPatient("pat_harriet", NOW)).toBeNull();
  });

  test("updateSurgery writes only the given fields", async () => {
    const updated = await store.updateSurgery("sur_harriet", { lastCheckedAt: "2026-10-03T20:01:00.000Z" });
    expect(updated.lastCheckedAt).toBe("2026-10-03T20:01:00.000Z");
    expect(updated.status).toBe("scheduled");
    await expect(store.updateSurgery("sur_nope", { status: "completed" })).rejects.toBeInstanceOf(NotFoundError);
  });

  test("unknown ids read as null", async () => {
    expect(await store.getSurgery("sur_nope")).toBeNull();
    expect(await store.getPatient("pat_nope")).toBeNull();
  });
});

describe("requirements", () => {
  test("upsert inserts, round-tripping jsonb columns", async () => {
    const source = { system: "rxclass" as const, detail: "Apixaban is B01AF", data: { rxcui: "1364445" } };
    const evidence = {
      type: "document" as const,
      summary: "Lab report",
      documentId: "doc_x",
      checks: [{ label: "Name matches", ok: true, detail: "Harriet" }],
    };
    const created = await store.upsertRequirement({ ...lab, source, evidence });
    expect(created.id).toStartWith("req_");
    expect(created).toMatchObject({ source, evidence, proposal: null, verifiedBy: null, staffNote: null });
    expect(await store.getRequirement(created.id)).toEqual(created);
    expect(await store.getRequirementByKey("sur_harriet", "preop_labs")).toEqual(created);
    expect(await store.getRequirementByKey("sur_harriet", "nope")).toBeNull();
  });

  test("upsert on the same key keeps id and createdAt, overwrites the rest and clears verification", async () => {
    const first = await store.upsertRequirement({ ...lab, source: { system: "rule", detail: "d" } });
    await store.updateRequirement(first.id, { verifiedBy: "nurse:Priya", verifiedAt: NOW.toISOString(), staffNote: "ok" });
    const second = await store.upsertRequirement({ ...lab, status: "evidence_received", reason: "New." });
    expect(second.id).toBe(first.id);
    expect(second.createdAt).toBe(first.createdAt);
    expect(second).toMatchObject({
      status: "evidence_received",
      reason: "New.",
      source: null,
      verifiedBy: null,
      verifiedAt: null,
      staffNote: null,
    });
    expect(new Date(second.updatedAt).getTime()).toBeGreaterThanOrEqual(new Date(first.updatedAt).getTime());
    expect(await store.listRequirements("sur_harriet")).toHaveLength(1);
  });

  test("updateRequirement changes only present keys, writes explicit nulls, bumps updatedAt", async () => {
    const created = await store.upsertRequirement({ ...lab, source: { system: "rule", detail: "d" } });
    const verified = await store.updateRequirement(created.id, {
      status: "verified",
      verifiedBy: "coordinator:Dana",
      verifiedAt: NOW.toISOString(),
      staffNote: "fine",
    });
    expect(verified).toMatchObject({ status: "verified", title: lab.title, source: { detail: "d" }, staffNote: "fine" });
    expect(verified.verifiedAt).toBe(NOW.toISOString());
    expect(new Date(verified.updatedAt).getTime()).toBeGreaterThan(new Date(created.updatedAt).getTime());

    const cleared = await store.updateRequirement(created.id, { verifiedBy: null, source: null, staffNote: null });
    expect(cleared).toMatchObject({ verifiedBy: null, source: null, staffNote: null, status: "verified" });
    expect(cleared.verifiedAt).toBe(NOW.toISOString());
  });

  test("updateRequirement with an empty patch still bumps updatedAt; missing rows throw not_found", async () => {
    const created = await store.upsertRequirement(lab);
    const same = await store.updateRequirement(created.id, {});
    expect(new Date(same.updatedAt).getTime()).toBeGreaterThan(new Date(created.updatedAt).getTime());
    await expect(store.updateRequirement("req_nope", { reason: "x" })).rejects.toThrow("not_found");
  });
});

describe("tasks", () => {
  test("create, list oldest first, update", async () => {
    const a = await store.createTask({ surgeryId: "sur_harriet", title: "A", owner: "nurse", origin: "staff" });
    const b = await store.createTask({
      surgeryId: "sur_harriet",
      title: "B",
      owner: "coordinator",
      origin: "agent",
      detail: "More.",
    });
    expect(a).toMatchObject({ status: "open", detail: "", requirementId: null, completedAt: null, completedBy: null });
    expect(b.detail).toBe("More.");
    expect((await store.listTasks("sur_harriet")).map((t) => t.title)).toEqual(["A", "B"]);

    const done = await store.updateTask(a.id, { status: "done", completedAt: NOW.toISOString(), completedBy: "nurse:Priya" });
    expect(done).toMatchObject({ status: "done", completedAt: NOW.toISOString(), completedBy: "nurse:Priya" });
    const reopened = await store.updateTask(a.id, { status: "open", completedAt: null, completedBy: null });
    expect(reopened).toMatchObject({ status: "open", completedAt: null, completedBy: null });
    expect(await store.getTask("tsk_nope")).toBeNull();
    await expect(store.updateTask("tsk_nope", { owner: "nurse" })).rejects.toThrow("not_found");
  });
});

describe("messages and outbox", () => {
  const base = { surgeryId: "sur_harriet", patientId: "pat_harriet", channel: "imessage" as const };

  test("create, list, update classification and attachments", async () => {
    const m = await store.createMessage({ ...base, direction: "in", body: "hello", deliveryStatus: "received" });
    expect(m).toMatchObject({ attachments: [], classification: null, deliveryStatus: "received" });
    const classification = {
      intent: "acknowledgement" as const,
      confidence: 0.9,
      summary: "Said hello.",
      requirementKey: null,
      faqTopic: null,
    };
    const updated = await store.updateMessage(m.id, {
      classification,
      attachments: [{ mimeType: "image/png", documentId: "doc_1" }],
    });
    expect(updated.classification).toEqual(classification);
    expect(updated.attachments).toEqual([{ mimeType: "image/png", documentId: "doc_1" }]);
    expect(await store.listMessages("sur_harriet")).toEqual([updated]);
    await expect(store.updateMessage("msg_nope", { deliveryStatus: "sent" })).rejects.toThrow("not_found");
  });

  test("outbox lists queued outbound messages for one channel, oldest first", async () => {
    const one = await store.createMessage({ ...base, direction: "out", body: "1", deliveryStatus: "queued" });
    await store.createMessage({ ...base, channel: "simulated", direction: "out", body: "sim", deliveryStatus: "queued" });
    await store.createMessage({ ...base, direction: "in", body: "in", deliveryStatus: "received" });
    const two = await store.createMessage({ ...base, direction: "out", body: "2", deliveryStatus: "queued" });
    expect((await store.listOutbox("imessage")).map((m) => m.body)).toEqual(["1", "2"]);
    await store.updateMessage(one.id, { deliveryStatus: "sent" });
    expect((await store.listOutbox("imessage")).map((m) => m.id)).toEqual([two.id]);
  });
});

describe("documents", () => {
  test("stores bytes separately from the record", async () => {
    const doc = await store.createDocument({
      surgeryId: "sur_harriet",
      mimeType: "image/png",
      base64: "aGVsbG8=",
      status: "needs_verification",
      extracted: { isLabReport: true, patientName: "H", collectedDate: "2026-09-29", facility: null, results: [], confidence: 1, notes: null },
    });
    expect(doc).not.toHaveProperty("base64");
    expect(doc).toMatchObject({ requirementId: null, messageId: null, status: "needs_verification" });
    expect(doc.extracted?.collectedDate).toBe("2026-09-29");
    expect(await store.getDocumentContent(doc.id)).toEqual({ mimeType: "image/png", base64: "aGVsbG8=" });
    expect(await store.getDocumentContent("doc_nope")).toBeNull();
    const updated = await store.updateDocument(doc.id, { status: "verified", extracted: null });
    expect(updated).toMatchObject({ status: "verified", extracted: null });
    expect(await store.listDocuments("sur_harriet")).toEqual([updated]);
  });

  test("a document can point at a requirement and message", async () => {
    const req = await store.upsertRequirement(lab);
    const msg = await store.createMessage({
      surgeryId: "sur_harriet",
      patientId: "pat_harriet",
      channel: "simulated",
      direction: "in",
      body: "photo",
      deliveryStatus: "received",
    });
    const doc = await store.createDocument({
      surgeryId: "sur_harriet",
      requirementId: req.id,
      messageId: msg.id,
      mimeType: "application/pdf",
      base64: "AA==",
      status: "unreadable",
    });
    expect(doc).toMatchObject({ requirementId: req.id, messageId: msg.id });
  });
});

describe("events", () => {
  test("newest first, with optional limit and null data", async () => {
    for (const n of [1, 2, 3]) {
      await store.addEvent({ surgeryId: "sur_harriet", type: "t", summary: `s${n}`, actor: "agent", data: n === 2 ? { n } : null });
    }
    const all = await store.listEvents("sur_harriet");
    expect(all.map((e) => e.summary)).toEqual(["s3", "s2", "s1"]);
    expect(all[1]?.data).toEqual({ n: 2 });
    expect(all[0]?.data).toBeNull();
    expect((await store.listEvents("sur_harriet", 2)).map((e) => e.summary)).toEqual(["s3", "s2"]);
    expect(await store.listEvents("sur_morgan")).toEqual([]);
  });
});

import { normalizePhone } from "./sqlStore.ts";
test("phones missing the +1 country code are normalised", () => {
  expect(normalizePhone("+2485550123")).toBe("+12485550123");
  expect(normalizePhone("(248) 555-0123")).toBe("+12485550123");
  expect(normalizePhone("12485550123")).toBe("+12485550123");
  expect(normalizePhone("+442071234567")).toBe("+442071234567");
});
