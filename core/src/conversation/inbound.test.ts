import { beforeEach, describe, expect, test } from "bun:test";
import { createFakeLlm } from "../llm/fake.ts";
import type { Classification, FaqTopic, InboundInput, InboundResult, Llm, Requirement, Surgery } from "../types.ts";
import { UnknownSenderError } from "../types.ts";
import { createInboundHandler } from "./inbound.ts";
import { createMemoryStore } from "./testing/memoryStore.ts";

const NOW = new Date("2026-10-03T20:00:00.000Z");
const CLINIC = { name: "Northstar Surgical Center", phone: "(734) 555-0100" };
const PHONE = "+17345550100";

function req(key: string, over: Partial<Requirement> = {}): Requirement {
  return {
    id: `req_${key}`, surgeryId: "sur_harriet", key, title: key, kind: "lab", status: "open", blocking: true, owner: "nurse",
    reason: "Open", source: null, proposal: null, evidence: null, verifiedBy: null, verifiedAt: null, staffNote: null,
    createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), ...over,
  };
}

function setup(opts: { requirements?: Requirement[]; llm?: Llm } = {}) {
  const store = createMemoryStore({ now: () => NOW });
  store.addPatient({ id: "pat_harriet", finchnodeSubject: null, displayName: "Harriet Lindqvist", phone: PHONE, birthDate: null, createdAt: NOW.toISOString() });
  const surgery: Surgery = {
    id: "sur_harriet", patientId: "pat_harriet", procedureCode: "TKA", procedureName: "Total knee replacement (right)",
    scheduledAt: "2026-10-08T12:30:00.000Z", location: "Northstar", surgeon: "Dr. Demo", status: "scheduled", lastCheckedAt: null, createdAt: NOW.toISOString(),
  };
  store.addSurgery(surgery);
  for (const r of opts.requirements ?? [req("preop_labs"), req("transport", { kind: "logistics", owner: "coordinator" }), req("fasting_ack", { blocking: false, kind: "instruction" })]) {
    store.addRequirement(r);
  }
  const handle = createInboundHandler({ store, llm: opts.llm ?? createFakeLlm(), clock: { now: () => NOW }, clinic: CLINIC });
  const say = (body: string, extra: Partial<InboundInput> = {}) => handle({ channel: "simulated", surgeryId: "sur_harriet", body, ...extra });
  return { store, handle, say };
}

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64");
const labJson = (over: Record<string, unknown> = {}) => ({
  isLabReport: true, patientName: "Harriet Lindqvist", collectedDate: "2026-09-29", facility: "Quillhaven Medical Group",
  results: ["Hemoglobin", "Platelets", "Creatinine", "Potassium", "Sodium", "Glucose"].map((name) => ({ name, value: "1", unit: null, flag: null })),
  confidence: 0.9, notes: null, ...over,
});
const photo = (value: unknown) => ({ mimeType: "image/jpeg", base64: b64(value) });

const FORBIDDEN = /\b(cancel|cleared|safe|dose|dosage|mg\b|stop taking|fast for|hours before)/i;
function expectSaneReplies(result: InboundResult) {
  for (const reply of result.replies) {
    expect(reply.length).toBeLessThan(320);
    expect(reply).not.toMatch(FORBIDDEN);
  }
}

let ctx: ReturnType<typeof setup>;
beforeEach(() => {
  ctx = setup();
});

describe("resolving the sender", () => {
  test("unknown phone throws UnknownSenderError", async () => {
    await expect(ctx.handle({ channel: "imessage", phone: "+19995550000", body: "hi" })).rejects.toBeInstanceOf(UnknownSenderError);
  });

  test("unknown surgery id throws UnknownSenderError", async () => {
    await expect(ctx.say("hi", { surgeryId: "sur_nope" })).rejects.toBeInstanceOf(UnknownSenderError);
  });

  test("neither phone nor surgery id throws", async () => {
    await expect(ctx.handle({ channel: "imessage", body: "hi" })).rejects.toBeInstanceOf(UnknownSenderError);
  });

  test("a known phone finds the next surgery", async () => {
    const r = await ctx.handle({ channel: "imessage", phone: PHONE, body: "What should I bring?" });
    expect(r.surgeryId).toBe("sur_harriet");
    expect((await ctx.store.listMessages("sur_harriet")).map((m) => [m.direction, m.channel])).toEqual([["in", "imessage"], ["out", "imessage"]]);
  });

  test("a surgery in the past is not found by phone", async () => {
    const late = createInboundHandler({ store: ctx.store, llm: createFakeLlm(), clock: { now: () => new Date("2026-11-01T00:00:00Z") }, clinic: CLINIC });
    await expect(late({ channel: "imessage", phone: PHONE, body: "hi" })).rejects.toBeInstanceOf(UnknownSenderError);
  });
});

describe("saving messages", () => {
  test("saves the inbound message with its classification and the replies as sent", async () => {
    const r = await ctx.say("I can't get a ride home");
    const messages = await ctx.store.listMessages("sur_harriet");
    expect(messages[0]).toMatchObject({ direction: "in", deliveryStatus: "received", body: "I can't get a ride home" });
    expect(messages[0]?.classification?.intent).toBe("transport_issue");
    expect(messages[1]).toMatchObject({ direction: "out", deliveryStatus: "sent", channel: "simulated", body: r.replies[0] });
    const types = (await ctx.store.listEvents("sur_harriet")).map((e) => e.type);
    expect(types).toContain("message_in");
    expect(types).toContain("message_out");
    expect(types).toContain("task_created");
    expect(types).toContain("requirement_updated");
  });
});

describe("intents", () => {
  test("outside_result_claim: task for the coordinator and a request for a photo", async () => {
    const r = await ctx.say("I did that test at another clinic last week");
    expect(r.classification?.intent).toBe("outside_result_claim");
    expect(r.effects).toEqual([{ type: "task_created", taskId: "tsk_1", title: "Obtain outside lab result", owner: "coordinator" }]);
    expect(r.replies).toEqual(["Thanks, Harriet. If you have the results, text me a photo of the report and I will pass it to your care team."]);
    const [task] = await ctx.store.listTasks("sur_harriet");
    expect(task).toMatchObject({ requirementId: "req_preop_labs", origin: "patient_message", owner: "coordinator" });
    expect(task?.detail).toContain("another clinic");
  });

  test("transport_issue: task, transport stays open with a new reason", async () => {
    const r = await ctx.say("I don't have anyone to drive me");
    const transport = await ctx.store.getRequirementByKey("sur_harriet", "transport");
    expect(transport).toMatchObject({ status: "open", reason: "The patient says they have no ride home." });
    expect(transport?.source?.system).toBe("patient_message");
    expect(r.effects.map((e) => e.type)).toEqual(["task_created", "requirement_updated"]);
    expect((await ctx.store.listTasks("sur_harriet"))[0]).toMatchObject({ title: "Arrange a ride home", owner: "coordinator" });
    expect(r.replies[0]).toContain("coordinator");
    expectSaneReplies(r);
  });

  test("transport_confirmed: evidence_received with a patient statement, never verified", async () => {
    const r = await ctx.say("My daughter is driving me");
    const transport = await ctx.store.getRequirementByKey("sur_harriet", "transport");
    expect(transport?.status).toBe("evidence_received");
    expect(transport?.reason).toStartWith("The patient says ");
    expect(transport?.reason).toEndWith("A staff member must confirm.");
    expect(transport?.evidence).toMatchObject({ type: "patient_statement", messageId: r.messageId });
    expect(r.effects).toEqual([{ type: "requirement_updated", requirementId: "req_transport", key: "transport", status: "evidence_received" }]);
    expect(await ctx.store.listTasks("sur_harriet")).toHaveLength(0);
    expectSaneReplies(r);
  });

  test("health_concern: blocking health_review, nurse task, and the safety reply", async () => {
    const r = await ctx.say("I've had a cough since Sunday");
    const review = await ctx.store.getRequirementByKey("sur_harriet", "health_review");
    expect(review).toMatchObject({ title: "New symptom reported", kind: "health", blocking: true, owner: "nurse", status: "open" });
    expect(review?.evidence?.type).toBe("patient_statement");
    expect((await ctx.store.listTasks("sur_harriet"))[0]).toMatchObject({ title: "Call patient about reported symptom", owner: "nurse", requirementId: review?.id });
    expect(r.replies[0]).toContain("911");
    expect(r.replies[0]).toContain(CLINIC.phone);
    expectSaneReplies(r);
  });

  test("health_concern twice does not duplicate the requirement or the task", async () => {
    await ctx.say("I have a fever");
    const second = await ctx.say("I feel sick");
    expect(second.effects).toEqual([]);
    expect(await ctx.store.listTasks("sur_harriet")).toHaveLength(1);
    expect((await ctx.store.listRequirements("sur_harriet")).filter((r) => r.key === "health_review")).toHaveLength(1);
  });

  test("a verified health_review is reopened by a new symptom", async () => {
    await ctx.say("I have a fever");
    await ctx.store.updateRequirement("req_1", { status: "verified" });
    await ctx.say("I have a cough");
    expect((await ctx.store.getRequirementByKey("sur_harriet", "health_review"))?.status).toBe("open");
  });

  test.each<[string, FaqTopic]>([
    ["What can I eat the night before?", "fasting"],
    ["What time should I arrive?", "arrival"],
    ["What should I bring?", "what_to_bring"],
  ])("question %p is answered from the fixed instructions", async (body, topic) => {
    const r = await ctx.say(body);
    expect(r.classification?.faqTopic).toBe(topic);
    expect(r.effects).toEqual([]);
    expect(r.replies).toHaveLength(1);
    expect(r.replies[0]).toContain(CLINIC.phone);
    expectSaneReplies(r);
  });

  test("the fasting answer gives no times", async () => {
    const r = await ctx.say("What can I eat the night before?");
    expect(r.replies[0]).toContain("exact fasting times");
    expect(r.replies[0]).not.toMatch(/\b\d+\s*(am|pm|hours?)\b|midnight/i);
  });

  test("medication question becomes a nurse task, with no advice", async () => {
    const r = await ctx.say("Should I stop my blood thinner?");
    const [task] = await ctx.store.listTasks("sur_harriet");
    expect(task).toMatchObject({ title: "Patient question about medication", owner: "nurse", detail: "Should I stop my blood thinner?" });
    expect(r.replies[0]).toContain("can't advise on medicines");
    expect(r.replies[0]).toContain("nurse");
    expectSaneReplies(r);
  });

  test("a question with no topic becomes a coordinator task", async () => {
    const r = await ctx.say("Who is my surgeon's assistant?");
    expect(r.classification?.faqTopic).toBe("none");
    expect((await ctx.store.listTasks("sur_harriet"))[0]).toMatchObject({ title: "Patient question", owner: "coordinator", detail: "Who is my surgeon's assistant?" });
  });

  test("acknowledgement with no earlier outbound message gets no reply", async () => {
    const r = await ctx.say("got it");
    expect(r.classification?.intent).toBe("acknowledgement");
    expect(r.replies).toEqual([]);
    expect(r.effects).toEqual([]);
  });

  test("acknowledgement after an outbound message gets a brief reply", async () => {
    const patient = "pat_harriet";
    await ctx.store.createMessage({ surgeryId: "sur_harriet", patientId: patient, direction: "out", channel: "simulated", body: "Hi Harriet", deliveryStatus: "sent" });
    const r = await ctx.say("ok thanks");
    expect(r.replies).toHaveLength(1);
    expect(r.effects).toEqual([]);
  });

  test("reschedule_request: coordinator task and a callback", async () => {
    const r = await ctx.say("can we move the date");
    expect((await ctx.store.listTasks("sur_harriet"))[0]).toMatchObject({ title: "Patient asked to reschedule", owner: "coordinator" });
    expect(r.replies[0]).toContain("coordinator");
    expectSaneReplies(r);
  });

  test("other: coordinator task with the exact text", async () => {
    const r = await ctx.say("The weather has been lovely.");
    expect(r.classification?.intent).toBe("other");
    expect((await ctx.store.listTasks("sur_harriet"))[0]).toMatchObject({ title: "Review patient message", owner: "coordinator", detail: "The weather has been lovely." });
    expect(r.replies[0]).toContain("passed your message");
  });

  test("low confidence is treated as other", async () => {
    const llm: Llm = {
      name: "stub",
      classifyReply: async (): Promise<Classification> => ({ intent: "health_concern", confidence: 0.3, summary: "Unsure.", requirementKey: null, faqTopic: null }),
      extractLabDocument: createFakeLlm().extractLabDocument,
    };
    const s = setup({ llm });
    const r = await s.say("hmm");
    expect(await s.store.getRequirementByKey("sur_harriet", "health_review")).toBeNull();
    expect((await s.store.listTasks("sur_harriet"))[0]?.title).toBe("Review patient message");
    expect(r.classification?.intent).toBe("health_concern");
  });

  test("empty body with no attachments does nothing", async () => {
    const r = await ctx.say("   ");
    expect(r.classification).toBeNull();
    expect(r.replies).toEqual([]);
    expect(r.effects).toEqual([]);
  });
});

describe("duplicate suppression", () => {
  test("the same outside-result claim twice makes one task", async () => {
    await ctx.say("I did that test at another clinic last week");
    const second = await ctx.say("I had blood work done elsewhere");
    expect(second.effects).toEqual([]);
    expect(await ctx.store.listTasks("sur_harriet")).toHaveLength(1);
    expect(second.replies).toHaveLength(1);
  });

  test("a completed task does not block a new one", async () => {
    await ctx.say("can we move the date");
    await ctx.store.updateTask("tsk_1", { status: "done" });
    await ctx.say("can we reschedule");
    expect(await ctx.store.listTasks("sur_harriet")).toHaveLength(2);
  });

  test("different unclassified messages each get a task", async () => {
    await ctx.say("The weather has been lovely.");
    await ctx.say("My cat is named Pickles.");
    expect(await ctx.store.listTasks("sur_harriet")).toHaveLength(2);
  });
});

describe("lab documents", () => {
  test("happy path: evidence_received with the contract checks and a nurse task", async () => {
    const r = await ctx.say("", { attachments: [photo(labJson())] });
    const preop = await ctx.store.getRequirementByKey("sur_harriet", "preop_labs");
    const [doc] = await ctx.store.listDocuments("sur_harriet");
    expect(preop?.status).toBe("evidence_received");
    expect(preop?.reason).toBe("The patient sent a lab report dated 2026-09-29. A staff member must verify it.");
    expect(preop?.evidence).toMatchObject({
      type: "document", documentId: doc?.id, messageId: r.messageId,
      summary: "Lab report from Quillhaven Medical Group, collected 2026-09-29, 6 results.",
      checks: [
        { label: "Collected within 30 days of surgery", ok: true, detail: "9 days before surgery" },
        { label: "Patient name matches", ok: true, detail: "Harriet Lindqvist" },
        { label: "Required results present", ok: true, detail: "hemoglobin, platelets, creatinine, potassium" },
      ],
    });
    expect(doc).toMatchObject({ status: "needs_verification", requirementId: "req_preop_labs", messageId: r.messageId });
    expect(await ctx.store.getDocumentContent(doc!.id)).toMatchObject({ mimeType: "image/jpeg" });
    expect((await ctx.store.listTasks("sur_harriet"))[0]).toMatchObject({ title: "Verify lab report from patient", owner: "nurse", origin: "document", requirementId: "req_preop_labs" });
    expect(r.effects.map((e) => e.type)).toEqual(["document_received", "requirement_updated", "task_created"]);
    expect(r.classification).toBeNull();
    expect(r.replies).toHaveLength(1);
    expect(r.replies[0]).toContain("review it");
    expectSaneReplies(r);
    const message = await ctx.store.getMessage(r.messageId);
    expect(message?.attachments).toEqual([{ mimeType: "image/jpeg", documentId: doc?.id ?? null }]);
  });

  test("a stale report is stored for review and the patient is told kindly", async () => {
    const r = await ctx.say("", { attachments: [photo(labJson({ collectedDate: "2026-07-14" }))] });
    const preop = await ctx.store.getRequirementByKey("sur_harriet", "preop_labs");
    expect(preop?.status).toBe("evidence_received");
    expect(preop?.evidence?.checks?.[0]).toMatchObject({ ok: false, detail: "86 days before surgery" });
    expect(r.replies[0]).toContain("more than 30 days before your surgery");
    expect(r.replies[0]).toContain("newer test");
    expectSaneReplies(r);
  });

  test("a report with no date says so in the reason", async () => {
    await ctx.say("", { attachments: [photo(labJson({ collectedDate: null }))] });
    expect((await ctx.store.getRequirementByKey("sur_harriet", "preop_labs"))?.reason).toBe("The patient sent a lab report with no readable date. A staff member must verify it.");
  });

  test("a photo that is not a lab report is unreadable and goes to the coordinator", async () => {
    const r = await ctx.say("", { attachments: [{ mimeType: "image/png", base64: Buffer.from([1, 2, 3, 200]).toString("base64") }] });
    const [doc] = await ctx.store.listDocuments("sur_harriet");
    expect(doc).toMatchObject({ status: "unreadable", requirementId: null });
    expect((await ctx.store.getRequirementByKey("sur_harriet", "preop_labs"))?.status).toBe("open");
    expect((await ctx.store.listTasks("sur_harriet"))[0]).toMatchObject({ title: "Review photo from patient", owner: "coordinator", origin: "document" });
    expect(r.replies[0]).toContain("clearer photo");
    expect(r.effects[0]).toMatchObject({ type: "document_received", status: "unreadable" });
  });

  test("when blood work is already verified the document is kept unlinked and the patient is told so", async () => {
    const s = setup({ requirements: [req("preop_labs", { status: "verified" })] });
    const r = await s.say("", { attachments: [photo(labJson())] });
    const [doc] = await s.store.listDocuments("sur_harriet");
    expect(doc).toMatchObject({ requirementId: null, status: "needs_verification" });
    expect((await s.store.getRequirementByKey("sur_harriet", "preop_labs"))?.status).toBe("verified");
    expect(await s.store.listTasks("sur_harriet")).toHaveLength(0);
    expect(r.replies[0]).toContain("already has what they need");
  });

  test("text plus an acceptable photo: no outside-result task and no photo request", async () => {
    const r = await ctx.say("I did that test at another clinic last week", { attachments: [photo(labJson())] });
    expect(r.classification?.intent).toBe("outside_result_claim");
    const titles = (await ctx.store.listTasks("sur_harriet")).map((t) => t.title);
    expect(titles).toEqual(["Verify lab report from patient"]);
    expect(r.replies).toHaveLength(1);
    expect(r.replies[0]).not.toContain("text me a photo");
  });

  test("text plus an unacceptable photo still creates the outside-result task but asks for no second photo", async () => {
    const r = await ctx.say("I did that test at another clinic last week", { attachments: [photo(labJson({ collectedDate: "2026-07-14" }))] });
    const titles = (await ctx.store.listTasks("sur_harriet")).map((t) => t.title);
    expect(titles).toEqual(["Verify lab report from patient", "Obtain outside lab result"]);
    expect(r.replies).toHaveLength(1);
  });

  test("a second report does not create a second verify task", async () => {
    await ctx.say("", { attachments: [photo(labJson())] });
    await ctx.say("", { attachments: [photo(labJson({ collectedDate: "2026-09-30" }))] });
    const titles = (await ctx.store.listTasks("sur_harriet")).map((t) => t.title);
    expect(titles).toEqual(["Verify lab report from patient"]);
    expect(await ctx.store.listDocuments("sur_harriet")).toHaveLength(2);
  });

  test("non-image attachments are ignored", async () => {
    const r = await ctx.say("", { attachments: [{ mimeType: "text/plain", base64: b64(labJson()) }] });
    expect(await ctx.store.listDocuments("sur_harriet")).toHaveLength(0);
    expect(r.effects).toEqual([]);
  });

  test("a PDF is read like an image", async () => {
    await ctx.say("", { attachments: [{ mimeType: "application/pdf", base64: b64(labJson()) }] });
    expect((await ctx.store.listDocuments("sur_harriet"))[0]?.mimeType).toBe("application/pdf");
  });
});

describe("safety", () => {
  test("no intent ever sets a requirement to verified, satisfied or waived", async () => {
    const messages = [
      "I did that test at another clinic last week", "I can't get a ride home", "My daughter is driving me", "I have a fever",
      "What can I eat the night before?", "What time should I arrive?", "What should I bring?", "Should I stop my blood thinner?",
      "ok thanks", "can we move the date", "random words here",
    ];
    for (const m of messages) await ctx.say(m);
    await ctx.say("", { attachments: [photo(labJson())] });
    await ctx.say("My husband will pick me up", { attachments: [photo(labJson())] });
    for (const r of await ctx.store.listRequirements("sur_harriet")) {
      expect(["verified", "satisfied", "waived"]).not.toContain(r.status);
    }
  });

  test("a verified requirement is never downgraded or edited by a document", async () => {
    const s = setup({ requirements: [req("preop_labs", { status: "verified", reason: "Staff verified" }), req("transport", { status: "waived", reason: "Waived" })] });
    await s.say("My daughter is driving me", { attachments: [photo(labJson())] });
    expect(await s.store.getRequirementByKey("sur_harriet", "preop_labs")).toMatchObject({ status: "verified", reason: "Staff verified" });
    expect(await s.store.getRequirementByKey("sur_harriet", "transport")).toMatchObject({ status: "waived", reason: "Waived" });
  });

  test("replies from every template are short and free of banned claims", async () => {
    const replies = await import("./replies.ts");
    const all = [
      replies.askForReportPhoto("Harriet"), replies.rideHelp("Harriet"), replies.rideNoted("Harriet"),
      replies.symptomCallback("Harriet", CLINIC.phone), replies.medicationQuestion("Harriet"), replies.questionPassedOn("Harriet"),
      replies.faqReply("fasting", CLINIC.phone), replies.faqReply("arrival", CLINIC.phone), replies.faqReply("what_to_bring", CLINIC.phone),
      replies.acknowledgementReply("Harriet"), replies.rescheduleCallback("Harriet"), replies.passedToTeam("Harriet"),
      replies.labAlreadyCovered("Harriet"), replies.photoUnreadable("Harriet"),
      replies.labReportReceived("Harriet", [{ label: "Collected within 30 days of surgery", ok: false, detail: "86 days before surgery" }]),
      replies.labReportReceived("Harriet", [{ label: "Collected within 30 days of surgery", ok: false, detail: "No collection date found" }]),
      replies.labReportReceived("Harriet", [{ label: "Patient name matches", ok: false, detail: "x" }]),
      replies.labReportReceived("Harriet", [{ label: "Required results present", ok: false, detail: "x" }]),
      replies.labReportReceived("Harriet", [{ label: "a", ok: false, detail: "" }, { label: "b", ok: false, detail: "" }]),
    ];
    for (const text of all) {
      expect(text).not.toBeNull();
      expect(text!.length).toBeLessThan(320);
      expect(text).not.toMatch(FORBIDDEN);
    }
    expect(replies.faqReply("medications", CLINIC.phone)).toBeNull();
  });
});
