import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import seedJson from "../../../db/seed/demo.json";
import { openMemoryStore } from "../store/open.ts";
import type {
  AppDeps,
  HandleInbound,
  InboundInput,
  Requirement,
  RunRecordCheck,
  SeedData,
  Store,
} from "../types.ts";
import { UnknownSenderError } from "../types.ts";
import { createApp } from "./app.ts";

const seed = seedJson as SeedData;
const NOW = new Date("2026-10-03T20:00:00.000Z");

let store: Store;
let runRecordCheck: RunRecordCheck;
let handleInbound: HandleInbound;
let app: ReturnType<typeof createApp>;
const inboundCalls: InboundInput[] = [];

beforeAll(async () => {
  store = await openMemoryStore();
});

beforeEach(async () => {
  process.env.DEMO_PATIENT_PHONE = "+17345550100";
  inboundCalls.length = 0;
  runRecordCheck = async (surgeryId) => ({ surgeryId, created: [], changed: [], outbound: [], warnings: [] });
  handleInbound = async (input) => {
    inboundCalls.push(input);
    return { surgeryId: "sur_harriet", messageId: "msg_stub", classification: null, replies: ["ok"], effects: [] };
  };
  const deps: AppDeps = {
    store,
    clock: { now: () => NOW },
    runRecordCheck: (id) => runRecordCheck(id),
    handleInbound: (input) => handleInbound(input),
    seed: () => seed,
    clinic: { name: "Northstar Surgical Center", phone: "(734) 555-0100" },
    info: { llm: "fake", database: "memory", records: "fixtures" },
  };
  app = createApp(deps);
  await store.reset(seed, NOW);
});

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any; res: Response }> {
  const res = await app.request(path, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: res.status, json, res };
}

const get = (path: string) => call("GET", path);
const post = (path: string, body?: unknown) => call("POST", path, body ?? {});

function expectError(r: { status: number; json: any }, status: number, code: string) {
  expect(r.status).toBe(status);
  expect(r.json.error.code).toBe(code);
  expect(typeof r.json.error.message).toBe("string");
  expect(r.json.error.message.length).toBeGreaterThan(0);
}

/** Harriet's three blockers from the contract example, plus a template proposal on the first. */
async function seedHarriet(): Promise<Requirement[]> {
  const anticoagulant = await store.upsertRequirement({
    surgeryId: "sur_harriet",
    key: "anticoagulant_plan",
    title: "Blood thinner plan",
    kind: "medication",
    status: "open",
    blocking: true,
    owner: "surgeon",
    reason: "Apixaban is an anticoagulant and no pause plan is on file.",
    source: { system: "rxclass", detail: "Apixaban 5 MG Oral Tablet is ATC B01AF (Direct factor Xa inhibitors)" },
    proposal: {
      templateKey: "anticoagulant_pause",
      drugName: "Apixaban 5 MG Oral Tablet",
      drugClass: "anticoagulant",
      text: "Hi Harriet, a note about your blood thinner. {{staff_instruction}} Please do not stop it otherwise.",
      requiresStaffInstruction: true,
    },
  });
  const labs = await store.upsertRequirement({
    surgeryId: "sur_harriet",
    key: "preop_labs",
    title: "Pre-op blood work within 30 days",
    kind: "lab",
    status: "open",
    blocking: true,
    owner: "nurse",
    reason: "The newest blood work is from 2026-07-14, 86 days before surgery.",
  });
  const transport = await store.upsertRequirement({
    surgeryId: "sur_harriet",
    key: "transport",
    title: "Ride home confirmed",
    kind: "logistics",
    status: "open",
    blocking: true,
    owner: "coordinator",
    reason: "The patient has not confirmed who will drive them home.",
  });
  await store.updateSurgery("sur_harriet", { lastCheckedAt: "2026-10-03T20:01:00.000Z" });
  return [anticoagulant, labs, transport];
}

async function actOn(id: string, action: string, extra: Record<string, unknown> = {}) {
  return post(`/requirements/${id}/actions`, { action, actor: "coordinator:Dana", ...extra });
}

describe("reads", () => {
  test("GET /health", async () => {
    const r = await get("/health");
    expect(r.json).toEqual({ ok: true, time: NOW.toISOString(), llm: "fake", database: "memory", records: "fixtures", auth: "off" });
  });

  test("GET /surgeries lists the seeded surgeries soonest first with readiness", async () => {
    const r = await get("/surgeries");
    expect(r.status).toBe(200);
    const list = r.json.surgeries;
    expect(list.map((s: any) => s.surgery.id)).toEqual(["sur_morgan", "sur_harriet", "sur_jordan"]);
    expect(list.map((s: any) => s.readiness.headline)).toEqual([
      "Ready",
      "Not checked yet",
      "Needs attention: 1 blocker, 12 days out",
    ]);
    expect(list[0].readiness).toEqual({
      level: "ready",
      blockers: 0,
      openBlockers: 0,
      pendingVerification: 0,
      daysUntil: 3,
      headline: "Ready",
    });
    expect(list[0].blockers).toEqual([]);
    expect(list[1].patient.phone).toBe("+17345550100");
    expect(list[2].blockers).toEqual([
      {
        id: expect.stringMatching(/^req_/),
        key: "transport",
        title: "Ride home confirmed",
        status: "open",
        owner: "coordinator",
        reason: "The patient has not confirmed who will drive them home.",
      },
    ]);
  });

  test("GET /surgeries/:id returns the full detail", async () => {
    await seedHarriet();
    await store.createTask({ surgeryId: "sur_harriet", title: "T", owner: "nurse", origin: "staff" });
    const r = await get("/surgeries/sur_harriet");
    expect(r.status).toBe(200);
    expect(Object.keys(r.json).sort()).toEqual(
      ["documents", "events", "messages", "outreach", "patient", "readiness", "requirements", "surgery", "tasks"],
    );
    expect(r.json.readiness.headline).toBe("At risk: 3 blockers, 5 days out");
    expect(r.json.requirements.map((q: any) => q.key)).toEqual(["anticoagulant_plan", "preop_labs", "transport"]);
    expect(r.json.tasks).toHaveLength(1);
  });

  test("detail events are newest first and capped at 50", async () => {
    for (let i = 0; i < 55; i++) {
      await store.addEvent({ surgeryId: "sur_morgan", type: "t", summary: `e${i}`, actor: "agent" });
    }
    const r = await get("/surgeries/sur_morgan");
    expect(r.json.events).toHaveLength(50);
    expect(r.json.events[0].summary).toBe("e54");
  });

  test("unknown surgery is 404 not_found", async () => {
    expectError(await get("/surgeries/sur_nope"), 404, "not_found");
    expectError(await get("/surgeries/sur_nope/brief"), 404, "not_found");
  });
});

describe("brief", () => {
  test("matches the contract example", async () => {
    await seedHarriet();
    const r = await get("/surgeries/sur_harriet/brief");
    expect(r.json.text).toBe(
      [
        "Harriet Lindqvist, Total knee replacement (right), Thu Oct 8. At risk: 3 blockers, 5 days out.",
        "1. Blood thinner plan (surgeon): Apixaban is an anticoagulant and no pause plan is on file.",
        "2. Pre-op blood work within 30 days (nurse): The newest blood work is from 2026-07-14, 86 days before surgery.",
        "3. Ride home confirmed (coordinator): The patient has not confirmed who will drive them home.",
        "Open tasks: none.",
      ].join("\n"),
    );
  });

  test("lists open tasks only, and has no blocker lines when ready", async () => {
    const open = await store.createTask({ surgeryId: "sur_morgan", title: "Call pharmacy", owner: "nurse", origin: "staff" });
    const done = await store.createTask({ surgeryId: "sur_morgan", title: "Old thing", owner: "coordinator", origin: "staff" });
    await store.updateTask(done.id, { status: "done" });
    expect(open.id).toBeTruthy();
    const r = await get("/surgeries/sur_morgan/brief");
    expect(r.json.text).toBe(
      ["Morgan Rivera, Total knee replacement (left), Tue Oct 6. Ready.", "Open tasks:", "- Call pharmacy (nurse)"].join("\n"),
    );
  });

  test("a surgery that was never checked reads as such", async () => {
    const r = await get("/surgeries/sur_harriet/brief");
    expect(r.json.text).toBe(
      "Harriet Lindqvist, Total knee replacement (right), Thu Oct 8. Not checked yet.\nOpen tasks: none.",
    );
  });
});

describe("POST /surgeries/:id/check", () => {
  test("calls the injected check and returns detail and result", async () => {
    const calls: string[] = [];
    runRecordCheck = async (id) => {
      calls.push(id);
      await seedHarriet();
      return { surgeryId: id, created: ["transport"], changed: [], outbound: [], warnings: ["w"] };
    };
    const r = await post("/surgeries/sur_harriet/check");
    expect(r.status).toBe(200);
    expect(calls).toEqual(["sur_harriet"]);
    expect(r.json.result).toEqual({ surgeryId: "sur_harriet", created: ["transport"], changed: [], outbound: [], warnings: ["w"] });
    expect(r.json.detail.readiness.headline).toBe("At risk: 3 blockers, 5 days out");
    expect(r.json.detail.requirements).toHaveLength(3);
  });

  test("unknown surgery is 404 and the check is not called", async () => {
    let called = false;
    runRecordCheck = async (id) => {
      called = true;
      return { surgeryId: id, created: [], changed: [], outbound: [], warnings: [] };
    };
    expectError(await post("/surgeries/sur_nope/check"), 404, "not_found");
    expect(called).toBe(false);
  });

  test("an upstream_failed error maps to 502", async () => {
    runRecordCheck = async () => {
      throw Object.assign(new Error("FinchNode unreachable"), { code: "upstream_failed" });
    };
    const r = await post("/surgeries/sur_harriet/check");
    expectError(r, 502, "upstream_failed");
    expect(r.json.error.message).toBe("FinchNode unreachable");
  });

  test("any other exception is a 500 internal that does not leak the message", async () => {
    runRecordCheck = async () => {
      throw new Error("secret details");
    };
    const original = console.error;
    console.error = () => {};
    try {
      const r = await post("/surgeries/sur_harriet/check");
      expectError(r, 500, "internal");
      expect(r.json.error.message).not.toContain("secret");
    } finally {
      console.error = original;
    }
  });
});

describe("requirement actions: verify", () => {
  test("verifies an open requirement and records an event", async () => {
    const [anticoagulant, labs] = await seedHarriet();
    const r = await actOn(labs!.id, "verify", { note: "  Seen at the clinic.  " });
    expect(r.status).toBe(200);
    expect(r.json.requirement).toMatchObject({
      id: labs!.id,
      status: "verified",
      verifiedBy: "coordinator:Dana",
      verifiedAt: NOW.toISOString(),
      staffNote: "Seen at the clinic.",
      reason: "Verified by coordinator:Dana.",
    });
    expect(r.json.outbound).toEqual([]);
    expect(r.json.readiness).toMatchObject({ blockers: 2, level: "at_risk" });
    expect(anticoagulant!.status).toBe("open");

    const events = await store.listEvents("sur_harriet");
    expect(events[0]).toMatchObject({
      type: "requirement_verified",
      actor: "coordinator:Dana",
      summary: 'coordinator:Dana verified "Pre-op blood work within 30 days".',
    });
  });

  test("verify without a note stores a null staffNote", async () => {
    const [, labs] = await seedHarriet();
    const r = await actOn(labs!.id, "verify");
    expect(r.json.requirement.staffNote).toBeNull();
  });

  test("verifying evidence_received marks the linked document verified", async () => {
    const [, labs] = await seedHarriet();
    const doc = await store.createDocument({
      surgeryId: "sur_harriet",
      requirementId: labs!.id,
      mimeType: "image/png",
      base64: "AA==",
      status: "needs_verification",
    });
    await store.updateRequirement(labs!.id, {
      status: "evidence_received",
      evidence: { type: "document", summary: "Lab report", documentId: doc.id },
    });
    const r = await actOn(labs!.id, "verify");
    expect(r.status).toBe(200);
    expect(r.json.requirement.status).toBe("verified");
    expect((await store.getDocument(doc.id))?.status).toBe("verified");
  });

  test("a verified or waived requirement cannot be verified again", async () => {
    const [, labs, transport] = await seedHarriet();
    await actOn(labs!.id, "verify");
    const again = await actOn(labs!.id, "verify");
    expectError(again, 409, "invalid_transition");
    await actOn(transport!.id, "waive", { note: "Not needed" });
    expectError(await actOn(transport!.id, "verify"), 409, "invalid_transition");
  });
});

describe("requirement actions: approve_template", () => {
  test("replaces the placeholder, queues an imessage to the patient and verifies", async () => {
    const [anticoagulant] = await seedHarriet();
    const r = await actOn(anticoagulant!.id, "approve_template", {
      note: "  Stop apixaban 3 days before surgery, last dose Monday.  ",
    });
    expect(r.status).toBe(200);
    expect(r.json.requirement).toMatchObject({
      status: "verified",
      verifiedBy: "coordinator:Dana",
      staffNote: "Stop apixaban 3 days before surgery, last dose Monday.",
    });
    expect(r.json.outbound).toHaveLength(1);
    expect(r.json.outbound[0]).toMatchObject({
      surgeryId: "sur_harriet",
      patientId: "pat_harriet",
      direction: "out",
      channel: "imessage",
      deliveryStatus: "queued",
      body: "Hi Harriet, a note about your blood thinner. Stop apixaban 3 days before surgery, last dose Monday. Please do not stop it otherwise.",
    });
    expect(r.json.readiness.blockers).toBe(2);
    expect((await store.listEvents("sur_harriet"))[0]?.type).toBe("template_approved");
  });

  test("the outbox shows the message with the patient's phone, and it can be marked sent", async () => {
    const [anticoagulant] = await seedHarriet();
    const approved = await actOn(anticoagulant!.id, "approve_template", { note: "Hold it." });
    const id = approved.json.outbound[0].id;

    const outbox = await get("/outbox?channel=imessage");
    expect(outbox.status).toBe(200);
    expect(outbox.json.messages).toHaveLength(1);
    expect(outbox.json.messages[0]).toMatchObject({ id, phone: "+17345550100", deliveryStatus: "queued" });
    expect((await get("/outbox")).json.messages).toHaveLength(1);
    expect((await get("/outbox?channel=simulated")).json.messages).toEqual([]);

    const sent = await post(`/outbox/${id}/sent`);
    expect(sent.status).toBe(200);
    expect(sent.json.message).toMatchObject({ id, deliveryStatus: "sent" });
    expect((await get("/outbox")).json.messages).toEqual([]);
    expect((await post(`/outbox/${id}/sent`)).status).toBe(200);
  });

  test("outbox phone is null when the patient has none", async () => {
    const jordanTransport = (await store.getRequirementByKey("sur_jordan", "transport"))!;
    await store.updateRequirement(jordanTransport.id, {
      proposal: { templateKey: "t", drugName: "d", drugClass: "diabetes", text: "Plain message.", requiresStaffInstruction: false },
    });
    const r = await actOn(jordanTransport.id, "approve_template");
    expect(r.json.outbound[0].body).toBe("Plain message.");
    expect((await get("/outbox")).json.messages[0].phone).toBeNull();
  });

  test("requires a note when the template needs a staff instruction", async () => {
    const [anticoagulant] = await seedHarriet();
    expectError(await actOn(anticoagulant!.id, "approve_template"), 400, "note_required");
    expectError(await actOn(anticoagulant!.id, "approve_template", { note: "   " }), 400, "note_required");
    expect((await store.getRequirement(anticoagulant!.id))?.status).toBe("open");
    expect(await store.listOutbox("imessage")).toEqual([]);
  });

  test("keeps dollar signs in the note literal", async () => {
    const [anticoagulant] = await seedHarriet();
    const r = await actOn(anticoagulant!.id, "approve_template", { note: "Cost is $& $1 today." });
    expect(r.json.outbound[0].body).toContain("Cost is $& $1 today.");
  });

  test("409 when there is no proposal or the requirement is not open", async () => {
    const [anticoagulant, labs] = await seedHarriet();
    expectError(await actOn(labs!.id, "approve_template", { note: "x" }), 409, "invalid_transition");
    await actOn(anticoagulant!.id, "approve_template", { note: "Hold it." });
    expectError(await actOn(anticoagulant!.id, "approve_template", { note: "Again" }), 409, "invalid_transition");
    expect(await store.listOutbox("imessage")).toHaveLength(1);
  });
});

describe("requirement actions: waive, reject_evidence, reopen", () => {
  test("waive needs a note, then waives", async () => {
    const [, , transport] = await seedHarriet();
    expectError(await actOn(transport!.id, "waive"), 400, "note_required");
    const r = await actOn(transport!.id, "waive", { note: "Patient stays overnight" });
    expect(r.json.requirement).toMatchObject({
      status: "waived",
      verifiedBy: "coordinator:Dana",
      verifiedAt: NOW.toISOString(),
      staffNote: "Patient stays overnight",
      reason: "Waived by coordinator:Dana: Patient stays overnight",
    });
    expect((await store.listEvents("sur_harriet"))[0]?.type).toBe("requirement_waived");
  });

  test("waive works from evidence_received but not from verified", async () => {
    const [, labs, transport] = await seedHarriet();
    await store.updateRequirement(labs!.id, { status: "evidence_received" });
    expect((await actOn(labs!.id, "waive", { note: "n" })).status).toBe(200);
    await actOn(transport!.id, "verify");
    expectError(await actOn(transport!.id, "waive", { note: "n" }), 409, "invalid_transition");
  });

  test("reject_evidence reopens the requirement and rejects the document", async () => {
    const [, labs] = await seedHarriet();
    const doc = await store.createDocument({
      surgeryId: "sur_harriet",
      requirementId: labs!.id,
      mimeType: "image/png",
      base64: "AA==",
      status: "needs_verification",
    });
    await store.updateRequirement(labs!.id, {
      status: "evidence_received",
      evidence: { type: "document", summary: "Lab report", documentId: doc.id },
      verifiedBy: "someone",
      verifiedAt: NOW.toISOString(),
    });
    expectError(await actOn(labs!.id, "reject_evidence"), 400, "note_required");
    const r = await actOn(labs!.id, "reject_evidence", { note: "Wrong patient" });
    expect(r.status).toBe(200);
    expect(r.json.requirement).toMatchObject({
      status: "open",
      verifiedBy: null,
      verifiedAt: null,
      staffNote: "Wrong patient",
    });
    expect(r.json.requirement.reason).toContain("Wrong patient");
    expect((await store.getDocument(doc.id))?.status).toBe("rejected");
    expect(r.json.readiness.openBlockers).toBe(3);
    expect((await store.listEvents("sur_harriet"))[0]?.type).toBe("evidence_rejected");
  });

  test("reject_evidence only from evidence_received", async () => {
    const [, labs] = await seedHarriet();
    expectError(await actOn(labs!.id, "reject_evidence", { note: "x" }), 409, "invalid_transition");
  });

  test("reopen clears verification from verified, waived and satisfied", async () => {
    const [, labs, transport] = await seedHarriet();
    await actOn(labs!.id, "verify");
    const reopened = await actOn(labs!.id, "reopen");
    expect(reopened.json.requirement).toMatchObject({
      status: "open",
      verifiedBy: null,
      verifiedAt: null,
      staffNote: null,
      reason: "Reopened by coordinator:Dana.",
    });
    expect((await store.listEvents("sur_harriet"))[0]?.type).toBe("requirement_reopened");

    await actOn(transport!.id, "waive", { note: "n" });
    expect((await actOn(transport!.id, "reopen", { note: "changed my mind" })).json.requirement.status).toBe("open");

    await store.updateRequirement(labs!.id, { status: "satisfied" });
    expect((await actOn(labs!.id, "reopen")).json.requirement.status).toBe("open");
  });

  test("reopen is invalid from open and evidence_received", async () => {
    const [, labs, transport] = await seedHarriet();
    expectError(await actOn(labs!.id, "reopen"), 409, "invalid_transition");
    await store.updateRequirement(transport!.id, { status: "evidence_received" });
    expectError(await actOn(transport!.id, "reopen"), 409, "invalid_transition");
  });

  test("verify on a seeded verified requirement is invalid and reopen works", async () => {
    const preop = (await store.getRequirementByKey("sur_morgan", "preop_labs"))!;
    expectError(await actOn(preop.id, "verify"), 409, "invalid_transition");
    const r = await actOn(preop.id, "reopen");
    expect(r.json.readiness).toMatchObject({ blockers: 1, level: "needs_attention", headline: "Needs attention: 1 blocker, 3 days out" });
  });
});

describe("requirement action validation", () => {
  test("rejects bad bodies with specific bad_request messages", async () => {
    const [, labs] = await seedHarriet();
    const path = `/requirements/${labs!.id}/actions`;
    const cases: Array<[unknown, string]> = [
      [{ actor: "x" }, "action"],
      [{ action: "explode", actor: "x" }, "action"],
      [{ action: "verify" }, "actor"],
      [{ action: "verify", actor: "  " }, "actor"],
      [{ action: "verify", actor: "x", note: 5 }, "note"],
    ];
    for (const [body, field] of cases) {
      const r = await post(path, body);
      expectError(r, 400, "bad_request");
      expect(r.json.error.message).toContain(field);
    }
    expectError(await post(path, "[1]"), 400, "bad_request");
  });

  test("unknown requirement is 404", async () => {
    expectError(await actOn("req_nope", "verify"), 404, "not_found");
  });
});

describe("tasks", () => {
  test("POST /tasks creates a staff task and an event", async () => {
    const [, labs] = await seedHarriet();
    const r = await post("/tasks", {
      surgeryId: "sur_harriet",
      title: "  Call the other clinic ",
      owner: "coordinator",
      detail: "Ask for the lab report",
      requirementId: labs!.id,
      actor: "coordinator:Dana",
    });
    expect(r.status).toBe(201);
    expect(r.json.task).toMatchObject({
      id: expect.stringMatching(/^tsk_/),
      surgeryId: "sur_harriet",
      requirementId: labs!.id,
      title: "Call the other clinic",
      detail: "Ask for the lab report",
      owner: "coordinator",
      status: "open",
      origin: "staff",
      completedAt: null,
      completedBy: null,
    });
    const event = (await store.listEvents("sur_harriet"))[0];
    expect(event).toMatchObject({ type: "task_created", actor: "coordinator:Dana" });
    expect(event?.summary).toContain("Call the other clinic");
  });

  test("agent origin defaults the actor to agent", async () => {
    const r = await post("/tasks", { surgeryId: "sur_harriet", title: "Follow up", owner: "nurse", origin: "agent" });
    expect(r.status).toBe(201);
    expect(r.json.task).toMatchObject({ origin: "agent", detail: "", requirementId: null });
    expect((await store.listEvents("sur_harriet"))[0]?.actor).toBe("agent");
  });

  test("validates the body", async () => {
    const [, labs] = await seedHarriet();
    const ok = { surgeryId: "sur_harriet", title: "T", owner: "nurse" };
    expectError(await post("/tasks", { ...ok, title: "" }), 400, "bad_request");
    expectError(await post("/tasks", { ...ok, owner: "janitor" }), 400, "bad_request");
    expectError(await post("/tasks", { ...ok, origin: "patient_message" }), 400, "bad_request");
    expectError(await post("/tasks", { ...ok, surgeryId: undefined }), 400, "bad_request");
    expectError(await post("/tasks", { ...ok, surgeryId: "sur_nope" }), 404, "not_found");
    expectError(await post("/tasks", { ...ok, requirementId: "req_nope" }), 404, "not_found");
    const other = (await store.getRequirementByKey("sur_morgan", "transport"))!;
    expectError(await post("/tasks", { ...ok, requirementId: other.id }), 400, "bad_request");
    expect(labs).toBeTruthy();
  });

  test("complete, reassign and reopen", async () => {
    const task = (await post("/tasks", { surgeryId: "sur_harriet", title: "T", owner: "nurse" })).json.task;
    const act = (body: Record<string, unknown>) => post(`/tasks/${task.id}/actions`, { actor: "nurse:Priya", ...body });

    const reassigned = await act({ action: "reassign", owner: "surgeon" });
    expect(reassigned.json.task.owner).toBe("surgeon");

    const done = await act({ action: "complete" });
    expect(done.status).toBe(200);
    expect(done.json.task).toMatchObject({ status: "done", completedAt: NOW.toISOString(), completedBy: "nurse:Priya" });
    expectError(await act({ action: "complete" }), 409, "invalid_transition");
    expectError(await act({ action: "reassign", owner: "nurse" }), 409, "invalid_transition");

    const reopened = await act({ action: "reopen" });
    expect(reopened.json.task).toMatchObject({ status: "open", completedAt: null, completedBy: null });
    expectError(await act({ action: "reopen" }), 409, "invalid_transition");

    const types = (await store.listEvents("sur_harriet")).map((e) => e.type);
    expect(types.slice(0, 4)).toEqual(["task_reopened", "task_completed", "task_reassigned", "task_created"]);
  });

  test("completing a task leaves its requirement alone", async () => {
    const [, labs] = await seedHarriet();
    const task = (await post("/tasks", { surgeryId: "sur_harriet", title: "T", owner: "nurse", requirementId: labs!.id })).json.task;
    await post(`/tasks/${task.id}/actions`, { action: "complete", actor: "nurse:Priya" });
    expect((await store.getRequirement(labs!.id))?.status).toBe("open");
  });

  test("validates task actions", async () => {
    const task = (await post("/tasks", { surgeryId: "sur_harriet", title: "T", owner: "nurse" })).json.task;
    const path = `/tasks/${task.id}/actions`;
    expectError(await post(path, { action: "reassign", actor: "x" }), 400, "bad_request");
    expectError(await post(path, { action: "reassign", actor: "x", owner: "janitor" }), 400, "bad_request");
    expectError(await post(path, { action: "nope", actor: "x" }), 400, "bad_request");
    expectError(await post(path, { action: "complete" }), 400, "bad_request");
    expectError(await post("/tasks/tsk_nope/actions", { action: "complete", actor: "x" }), 404, "not_found");
  });
});

describe("POST /messages/inbound", () => {
  test("passes a validated body to handleInbound and returns its result", async () => {
    const r = await post("/messages/inbound", {
      channel: "simulated",
      surgeryId: "sur_harriet",
      body: "I did that test elsewhere",
      attachments: [{ mimeType: "image/jpeg", base64: "AAAA" }],
    });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ surgeryId: "sur_harriet", messageId: "msg_stub", replies: ["ok"] });
    expect(inboundCalls).toEqual([
      {
        channel: "simulated",
        surgeryId: "sur_harriet",
        body: "I did that test elsewhere",
        attachments: [{ mimeType: "image/jpeg", base64: "AAAA" }],
      },
    ]);
  });

  test("accepts a phone instead of a surgery id, and an empty body text", async () => {
    const r = await post("/messages/inbound", { channel: "imessage", phone: "+1 (734) 555-0100", body: "" });
    expect(r.status).toBe(200);
    expect(inboundCalls[0]).toEqual({ channel: "imessage", phone: "+1 (734) 555-0100", body: "" });
  });

  test("UnknownSenderError becomes 404 unknown_sender", async () => {
    handleInbound = async () => {
      throw new UnknownSenderError();
    };
    expectError(await post("/messages/inbound", { channel: "imessage", phone: "+15550000000", body: "hi" }), 404, "unknown_sender");
  });

  test("validates the body", async () => {
    const ok = { channel: "simulated", surgeryId: "sur_harriet", body: "hi" };
    expectError(await post("/messages/inbound", { ...ok, channel: "fax" }), 400, "bad_request");
    expectError(await post("/messages/inbound", { ...ok, body: undefined }), 400, "bad_request");
    expectError(await post("/messages/inbound", { channel: "simulated", body: "hi" }), 400, "bad_request");
    expectError(await post("/messages/inbound", { ...ok, attachments: "x" }), 400, "bad_request");
    expectError(await post("/messages/inbound", { ...ok, attachments: [{ mimeType: "image/png" }] }), 400, "bad_request");
    expect(inboundCalls).toEqual([]);
  });

  test("a 6 MB attachment (about 8 MB of base64) gets through", async () => {
    const base64 = Buffer.alloc(6 * 1024 * 1024, 7).toString("base64");
    const r = await post("/messages/inbound", {
      channel: "simulated",
      surgeryId: "sur_harriet",
      body: "photo",
      attachments: [{ mimeType: "application/pdf", base64 }],
    });
    expect(r.status).toBe(200);
    expect(inboundCalls[0]?.attachments?.[0]?.base64.length).toBe(base64.length);
  });
});

describe("outbox errors", () => {
  test("bad channel is 400, unknown message is 404, inbound messages cannot be marked sent", async () => {
    expectError(await get("/outbox?channel=fax"), 400, "bad_request");
    expectError(await post("/outbox/msg_nope/sent"), 404, "not_found");
    const inbound = await store.createMessage({
      surgeryId: "sur_harriet",
      patientId: "pat_harriet",
      direction: "in",
      channel: "simulated",
      body: "hi",
      deliveryStatus: "received",
    });
    expectError(await post(`/outbox/${inbound.id}/sent`), 409, "invalid_transition");
  });
});

describe("GET /documents/:id/content", () => {
  test("returns the original bytes with the stored content type", async () => {
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x10, 0x80]);
    const doc = await store.createDocument({
      surgeryId: "sur_harriet",
      mimeType: "image/png",
      base64: Buffer.from(bytes).toString("base64"),
      status: "needs_verification",
    });
    const res = await app.request(`/documents/${doc.id}/content`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
  });

  test("unknown document is 404 JSON", async () => {
    expectError(await get("/documents/doc_nope/content"), 404, "not_found");
  });
});

describe("POST /demo/reset", () => {
  test("clears everything and reloads the seed", async () => {
    await seedHarriet();
    await post("/tasks", { surgeryId: "sur_harriet", title: "T", owner: "nurse" });
    const r = await post("/demo/reset");
    expect(r.json).toEqual({ ok: true, surgeries: 3 });
    const detail = (await get("/surgeries/sur_harriet")).json;
    expect(detail.requirements).toEqual([]);
    expect(detail.tasks).toEqual([]);
    expect(detail.readiness.headline).toBe("Not checked yet");
  });
});

describe("errors and CORS", () => {
  test("unknown routes use the envelope", async () => {
    const r = await get("/nope");
    expectError(r, 404, "not_found");
    expectError(await call("DELETE", "/surgeries"), 404, "not_found");
  });

  test("malformed JSON is bad_request", async () => {
    const r = await post("/tasks", "{not json");
    expectError(r, 400, "bad_request");
    expect(r.json.error.message).toContain("JSON");
    expectError(await post("/tasks", ""), 400, "bad_request");
  });

  test("CORS is open on success, errors and preflight", async () => {
    const ok = await app.request("/health", { headers: { Origin: "http://localhost:5173" } });
    expect(ok.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const bad = await app.request("/surgeries/sur_nope", { headers: { Origin: "http://localhost:5173" } });
    expect(bad.status).toBe(404);
    expect(bad.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const pre = await app.request("/tasks", {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:5173",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
      },
    });
    expect(pre.status).toBeLessThan(300);
    expect(pre.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});

describe("patient outreach", () => {
  async function approve() {
    const [anticoagulant] = await seedHarriet();
    const r = await actOn(anticoagulant!.id, "approve_template", { note: "Hold it." });
    return { requirementId: anticoagulant!.id, messageId: r.json.outbound[0].id as string };
  }
  const outreach = async () => (await get("/surgeries/sur_harriet")).json.outreach;

  test("approval clears the requirement and tracks the message as queued", async () => {
    const { requirementId, messageId } = await approve();
    expect(await outreach()).toEqual([{ requirementId, messageId, deliveryStatus: "queued", deliveryError: null, acknowledgedAt: null }]);
    await post(`/outbox/${messageId}/sent`);
    expect((await outreach())[0].deliveryStatus).toBe("sent");
  });

  test("a failed send stays visible, leaves the outbox, and can be retried", async () => {
    const { messageId } = await approve();
    const failed = await post(`/outbox/${messageId}/failed`, { error: "Recipient unreachable" });
    expect(failed.status).toBe(200);
    expect(failed.json.message).toMatchObject({ deliveryStatus: "failed", deliveryError: "Recipient unreachable" });
    expect((await outreach())[0]).toMatchObject({ deliveryStatus: "failed", deliveryError: "Recipient unreachable" });
    expect((await get("/outbox")).json.messages).toEqual([]);
    expect((await store.listEvents("sur_harriet"))[0]?.type).toBe("message_failed");

    expect((await post(`/outbox/${messageId}/failed`, {})).status).toBe(409);
    const retried = await post(`/messages/${messageId}/retry`, { actor: "coordinator:Dana" });
    expect(retried.status).toBe(200);
    expect(retried.json.message).toMatchObject({ deliveryStatus: "queued", deliveryError: null });
    expect((await get("/outbox")).json.messages).toHaveLength(1);
    expect((await post(`/messages/${messageId}/retry`)).status).toBe(409);
  });

  test("an acknowledgement after the message is recorded; one before it is not", async () => {
    const ackMessage = (body: string) =>
      store.createMessage({
        surgeryId: "sur_harriet",
        patientId: "pat_harriet",
        direction: "in",
        channel: "simulated",
        body,
        deliveryStatus: "received",
        classification: { intent: "acknowledgement", confidence: 0.9, summary: body, requirementKey: null, faqTopic: null },
      });
    const [anticoagulant] = await seedHarriet();
    await ackMessage("ok");
    const r = await actOn(anticoagulant!.id, "approve_template", { note: "Hold it." });
    expect((await outreach())[0].acknowledgedAt).toBeNull();
    const ack = await ackMessage("Got it, thanks");
    expect((await outreach())[0].acknowledgedAt).toBe(ack.createdAt);
    expect(r.json.outbound).toHaveLength(1);
  });

  test("reopening the requirement drops its outreach link", async () => {
    const { requirementId } = await approve();
    await actOn(requirementId, "reopen");
    expect(await outreach()).toEqual([]);
  });
});
