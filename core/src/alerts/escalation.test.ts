import { beforeEach, describe, expect, test } from "bun:test";
import seedJson from "../../../db/seed/demo.json";
import { parseStaffAllowlist, type AuthConfig } from "../auth/auth.ts";
import { createApp } from "../http/app.ts";
import { openMemoryStores } from "../store/open.ts";
import type { AlertStore, AppDeps, SeedData, Store } from "../types.ts";
import { createEscalation, type Escalation } from "./escalation.ts";

const seed = seedJson as SeedData;
const MINUTE = 60_000;

let now: Date;
let store: Store;
let alerts: AlertStore;
let escalation: Escalation;
let app: ReturnType<typeof createApp>;

async function setup(auth?: AuthConfig) {
  now = new Date("2026-10-03T20:00:00.000Z");
  ({ store, alerts } = await openMemoryStores());
  process.env.ONCALL_PRIMARY_PHONE = "+17345550201";
  process.env.ONCALL_BACKUP_PHONE = "+17345550202";
  delete process.env.ONCALL_LAST_PHONE;
  process.env.DEMO_PATIENT_PHONE = "+17345550100";
  await store.reset(seed, now);
  await alerts.syncSeedPhones(seed);
  const clock = { now: () => now };
  const clinic = { name: "Northstar Surgical Center", phone: "(734) 555-0100" };
  escalation = createEscalation({ store, alerts, clock, clinic, escalateAfterMs: 5 * MINUTE });
  const deps: AppDeps = {
    store,
    clock,
    clinic,
    runRecordCheck: async (surgeryId) => ({ surgeryId, created: [], changed: [], outbound: [], warnings: [] }),
    handleInbound: async () => ({ surgeryId: "sur_harriet", messageId: "msg_x", classification: null, replies: ["patient path"], effects: [] }),
    seed: () => seed,
    info: { llm: "fake", database: "memory", records: "fixtures" },
    auth: auth ?? null,
    escalation,
    alerts,
  };
  app = createApp(deps);
}

async function call(method: string, path: string, body?: unknown, token?: string) {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: (await res.json().catch(() => null)) as any };
}

const raise = () => escalation.raise({ surgeryId: "sur_harriet", summary: "Patient reports chest pain since this morning", messageId: null });

describe("escalation ladder", () => {
  beforeEach(() => setup());

  test("a new alert texts the first person on call and is logged", async () => {
    const alert = await raise();
    expect(alert).toMatchObject({ status: "open", level: 0, notifiedContactId: "stf_priya", exhausted: false });
    expect(alert.escalateAfter).toBe(new Date(now.getTime() + 5 * MINUTE).toISOString());
    const queued = await alerts.queuedNotifications();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ contactId: "stf_priya", phone: "+17345550201", deliveryStatus: "queued" });
    expect(queued[0]!.body).toContain("Harriet Lindqvist");
    expect(queued[0]!.body).toContain("Reply ACK");
    const types = (await store.listEvents("sur_harriet")).map((e) => e.type);
    expect(types).toContain("alert_raised");
    expect(types).toContain("alert_notified");
  });

  test("a second symptom message joins the live alert instead of paging again", async () => {
    const first = await raise();
    const again = await raise();
    expect(again.id).toBe(first.id);
    expect(await alerts.queuedNotifications()).toHaveLength(1);
  });

  test("nobody acknowledges: it escalates to the backup, then the last contact, then is marked unanswered", async () => {
    await raise();
    expect(await escalation.tick()).toBe(0);

    now = new Date(now.getTime() + 5 * MINUTE);
    expect(await escalation.tick()).toBe(1);
    let alert = (await alerts.listAlerts())[0]!;
    expect(alert).toMatchObject({ level: 1, notifiedContactId: "stf_avery" });

    // The last contact has no phone: the notification is recorded as failed, and the clock keeps running.
    now = new Date(now.getTime() + 5 * MINUTE);
    await escalation.tick();
    alert = (await alerts.listAlerts())[0]!;
    expect(alert).toMatchObject({ level: 2, notifiedContactId: "stf_dana" });
    const notes = await alerts.listNotifications(alert.id);
    expect(notes.map((n) => n.deliveryStatus)).toEqual(["queued", "queued", "failed"]);
    expect(notes[2]!.deliveryError).toContain("No phone");

    now = new Date(now.getTime() + 5 * MINUTE);
    await escalation.tick();
    alert = (await alerts.listAlerts())[0]!;
    expect(alert).toMatchObject({ exhausted: true, escalateAfter: null, status: "open" });
    expect((await store.listEvents("sur_harriet"))[0]!.type).toBe("alert_unanswered");
    now = new Date(now.getTime() + 60 * MINUTE);
    expect(await escalation.tick()).toBe(0);
  });

  test("acknowledging stops escalation and only then tells the patient who has it", async () => {
    const alert = await raise();
    const before = (await store.listMessages("sur_harriet")).length;
    await escalation.acknowledge(alert.id, "nurse:Priya Shah");
    now = new Date(now.getTime() + 30 * MINUTE);
    expect(await escalation.tick()).toBe(0);
    const messages = await store.listMessages("sur_harriet");
    expect(messages).toHaveLength(before + 1);
    expect(messages.at(-1)).toMatchObject({ direction: "out", channel: "imessage", deliveryStatus: "queued" });
    expect(messages.at(-1)!.body).toStartWith("Hi Harriet, Priya Shah from your care team has your message");
    await expect(escalation.acknowledge(alert.id, "nurse:Priya Shah")).rejects.toThrow("already acknowledged");
  });

  test("resolving records who and how", async () => {
    const alert = await raise();
    const resolved = await escalation.resolve(alert.id, "surgeon:Dr. Avery Demo", "Called patient; reflux, no cardiac signs.");
    expect(resolved).toMatchObject({ status: "resolved", resolvedBy: "surgeon:Dr. Avery Demo", resolution: "Called patient; reflux, no cardiac signs." });
    expect(await alerts.listAlerts({ activeOnly: true })).toEqual([]);
  });
});

describe("staff replies and the outbox", () => {
  beforeEach(() => setup());

  test("ACK from the paged nurse's phone acknowledges through the inbound route", async () => {
    await raise();
    const r = await call("POST", "/messages/inbound", { channel: "imessage", phone: "(734) 555-0201", body: "ack" });
    expect(r.status).toBe(200);
    expect(r.json.replies[0]).toContain("You have Harriet Lindqvist's alert");
    expect((await alerts.listAlerts())[0]).toMatchObject({ status: "acknowledged", acknowledgedBy: "nurse:Priya Shah" });
  });

  test("other text from a staff phone gets instructions, and a patient phone still reaches the patient path", async () => {
    await raise();
    const staff = await call("POST", "/messages/inbound", { channel: "imessage", phone: "+17345550201", body: "what is this" });
    expect(staff.json.replies[0]).toContain("Reply ACK");
    const patient = await call("POST", "/messages/inbound", { channel: "imessage", phone: "+17345550100", body: "hello" });
    expect(patient.json.replies).toEqual(["patient path"]);
  });

  test("a phone that is both patient and on-call: only ACK during an open alert is treated as staff", async () => {
    process.env.ONCALL_PRIMARY_PHONE = "+17345550100";
    await alerts.syncSeedPhones(seed);
    const hello = await call("POST", "/messages/inbound", { channel: "imessage", phone: "+17345550100", body: "I have a fever" });
    expect(hello.json.replies).toEqual(["patient path"]);
    const okBefore = await call("POST", "/messages/inbound", { channel: "imessage", phone: "+17345550100", body: "ok" });
    expect(okBefore.json.replies).toEqual(["patient path"]);
    await raise();
    const ack = await call("POST", "/messages/inbound", { channel: "imessage", phone: "+17345550100", body: "ACK" });
    expect(ack.json.replies[0]).toContain("You have Harriet Lindqvist's alert");
  });

  test("staff alert texts appear in the imessage outbox and can be marked sent or failed", async () => {
    await raise();
    const outbox = await call("GET", "/outbox?channel=imessage");
    const ntf = outbox.json.messages.find((m: any) => String(m.id).startsWith("ntf_"));
    expect(ntf).toMatchObject({ phone: "+17345550201", deliveryStatus: "queued" });
    expect((await call("POST", `/outbox/${ntf.id}/failed`, { error: "Target not allowed" })).status).toBe(200);
    expect((await alerts.listNotifications((await alerts.listAlerts())[0]!.id))[0]).toMatchObject({ deliveryStatus: "failed", deliveryError: "Target not allowed" });
    expect((await call("GET", "/outbox?channel=imessage")).json.messages.some((m: any) => m.id === ntf.id)).toBe(false);
  });

  test("alert routes: list, acknowledge, resolve with a note, and the surgery detail shows them", async () => {
    const alert = await raise();
    const list = await call("GET", "/alerts");
    expect(list.json.alerts).toHaveLength(1);
    expect(list.json.alerts[0]).toMatchObject({ patientName: "Harriet Lindqvist", notified: { name: "Priya Shah", role: "nurse" }, next: { name: "Dr. Avery Demo", role: "surgeon" } });

    const ack = await call("POST", `/alerts/${alert.id}/acknowledge`, { actor: "nurse:Priya" });
    expect(ack.json.alert).toMatchObject({ status: "acknowledged", next: null });
    expect((await call("POST", `/alerts/${alert.id}/acknowledge`, {})).status).toBe(409);
    expect((await call("POST", `/alerts/${alert.id}/resolve`, {})).status).toBe(400);
    const done = await call("POST", `/alerts/${alert.id}/resolve`, { note: "Seen in clinic.", actor: "nurse:Priya" });
    expect(done.json.alert.status).toBe("resolved");
    expect((await call("GET", "/alerts")).json.alerts).toEqual([]);
    expect((await call("GET", "/alerts?status=all")).json.alerts).toHaveLength(1);

    const detail = await call("GET", "/surgeries/sur_harriet");
    expect(detail.json.alerts[0]).toMatchObject({ id: alert.id, status: "resolved", resolution: "Seen in clinic." });
    expect((await call("POST", "/alerts/alr_missing/acknowledge", {})).status).toBe(404);
  });
});

describe("alert permissions", () => {
  test("any staff member may acknowledge; only clinical roles may resolve", async () => {
    await setup({
      verifyToken: async (token) => {
        const [, sub] = token.split(":");
        return { sub, email: `${sub}@example.edu`, emailVerified: true };
      },
      staff: parseStaffAllowlist("dana@example.edu,coordinator,Dana; priya@example.edu,nurse,Priya"),
    });
    const alert = await raise();
    expect((await call("POST", `/alerts/${alert.id}/resolve`, { note: "x" }, "jwt:dana")).status).toBe(403);
    const ack = await call("POST", `/alerts/${alert.id}/acknowledge`, { actor: "forged" }, "jwt:dana");
    expect(ack.json.alert.acknowledgedBy).toBe("coordinator:Dana");
    expect((await call("POST", `/alerts/${alert.id}/resolve`, { note: "Called her." }, "jwt:priya")).json.alert.resolvedBy).toBe("nurse:Priya");
    expect((await call("GET", "/alerts")).status).toBe(401);
  });
});
