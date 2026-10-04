import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import {
  actorFor,
  authenticate,
  AuthError,
  isClinicalKind,
  requirePermission,
  type Identity,
  type Permission,
} from "../auth/auth.ts";
import { AlertTransitionError } from "../alerts/escalation.ts";
import { NotFoundError } from "../store/errors.ts";
import type { AppDeps, InboundAttachment, InboundInput } from "../types.ts";
import { UnknownSenderError } from "../types.ts";
import { applyRequirementAction, applyTaskAction, createTaskFromBody } from "./actions.ts";
import { briefText, buildDetail, buildSummary, requireSurgery } from "./detail.ts";
import { badRequest, HttpError, invalidTransition, notFound } from "./errors.ts";
import {
  CHANNELS,
  OWNERS,
  optionalString,
  readJsonObject,
  requireOneOf,
  type Body,
} from "./validate.ts";

// Attachments arrive as base64 inside JSON; 6 MB of file is about 8 MB of text.
const MAX_BODY_BYTES = 32 * 1024 * 1024;

function parseInbound(body: Body): InboundInput {
  const channel = requireOneOf(body, "channel", CHANNELS);
  if (typeof body.body !== "string") throw badRequest('"body" is required and must be a string');
  const phone = optionalString(body, "phone");
  const surgeryId = optionalString(body, "surgeryId");
  if (!phone && !surgeryId) throw badRequest('Give "surgeryId" or "phone" to identify the patient');

  const input: InboundInput = { channel, body: body.body };
  if (phone) input.phone = phone;
  if (surgeryId) input.surgeryId = surgeryId;

  if (body.attachments !== undefined && body.attachments !== null) {
    if (!Array.isArray(body.attachments)) throw badRequest('"attachments" must be an array');
    input.attachments = body.attachments.map((a, i): InboundAttachment => {
      const item = a as Record<string, unknown> | null;
      if (!item || typeof item.mimeType !== "string" || typeof item.base64 !== "string" || item.base64 === "") {
        throw badRequest(`"attachments[${i}]" needs a "mimeType" string and a "base64" string`);
      }
      return { mimeType: item.mimeType, base64: item.base64 };
    });
  }
  return input;
}

type Env = { Variables: { identity: Identity } };

export function createApp(deps: AppDeps): Hono<Env> {
  const { store, clock } = deps;
  const app = new Hono<Env>();
  const auth = deps.auth ?? null;

  app.use("*", deps.corsOrigins ? cors({ origin: deps.corsOrigins }) : cors());
  app.use(
    "*",
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) => c.json({ error: { code: "bad_request", message: "Request body is too large" } }, 400),
    }),
  );

  app.get("/health", (c) =>
    c.json({
      ok: true,
      time: clock.now().toISOString(),
      llm: deps.info.llm,
      database: deps.info.database,
      records: deps.info.records,
      auth: auth ? "neon" : "off",
    }),
  );

  // For load balancers and container health checks: 200 only when the database answers.
  app.get("/ready", async (c) => {
    try {
      await store.listSurgeries();
      return c.json({ ok: true, database: deps.info.database });
    } catch {
      return c.json({ ok: false, database: deps.info.database }, 503);
    }
  });

  // Everything below /health needs a caller. With auth off every caller is trusted ("open").
  app.use("*", async (c, next) => {
    const identity: Identity = auth
      ? await authenticate(auth, {
          authorization: c.req.header("authorization"),
          sender: c.req.header("x-readyfor-sender"),
        })
      : { kind: "open" };
    c.set("identity", identity);
    await next();
  });

  const can = (c: { get: (key: "identity") => Identity }, permission: Permission): string | null => {
    const identity = c.get("identity");
    requirePermission(identity, permission);
    return actorFor(identity);
  };

  /** Surgery detail plus its urgent alerts. */
  const detailFor = async (surgery: Awaited<ReturnType<typeof requireSurgery>>) => {
    const detail = await buildDetail(store, surgery, clock.now());
    if (deps.escalation && deps.alerts) {
      detail.alerts = await Promise.all((await deps.alerts.listAlerts({ surgeryId: surgery.id })).map((a) => deps.escalation!.view(a)));
    }
    return detail;
  };

  const requireAlerts = () => {
    if (!deps.escalation || !deps.alerts) throw new HttpError(404, "not_found", "Urgent escalation is not configured");
    return { escalation: deps.escalation, alerts: deps.alerts };
  };

  app.get("/me", (c) => {
    const identity = c.get("identity");
    return c.json({ identity, actor: actorFor(identity), auth: auth ? "neon" : "off" });
  });

  app.get("/surgeries", async (c) => {
    can(c, "read");
    const now = clock.now();
    const surgeries = await store.listSurgeries();
    return c.json({ surgeries: await Promise.all(surgeries.map((s) => buildSummary(store, s, now))) });
  });

  app.get("/surgeries/:id", async (c) => {
    can(c, "read");
    const surgery = await requireSurgery(store, c.req.param("id"));
    return c.json(await detailFor(surgery));
  });

  app.get("/surgeries/:id/brief", async (c) => {
    can(c, "read");
    const surgery = await requireSurgery(store, c.req.param("id"));
    const detail = await buildDetail(store, surgery, clock.now());
    return c.json({
      text: briefText(detail.surgery, detail.patient, detail.readiness, detail.requirements, detail.tasks),
    });
  });

  app.post("/surgeries/:id/check", async (c) => {
    can(c, "record_check");
    const surgery = await requireSurgery(store, c.req.param("id"));
    const result = await deps.runRecordCheck(surgery.id);
    const fresh = await requireSurgery(store, surgery.id);
    return c.json({ detail: await detailFor(fresh), result });
  });

  app.post("/requirements/:id/actions", async (c) => {
    const actor = can(c, "requirement_action");
    // Lab, medication and health decisions need a clinical role. Unknown ids fall through to the 404.
    const requirement = await store.getRequirement(c.req.param("id"));
    if (requirement && isClinicalKind(requirement.kind)) can(c, "clinical_requirement_action");
    const body = await readJsonObject(c);
    return c.json(await applyRequirementAction(store, clock.now(), c.req.param("id"), body, actor));
  });

  // Open work across every surgery, for a "My tasks" view. Filter by owner role and status.
  app.get("/tasks", async (c) => {
    can(c, "read");
    const owner = c.req.query("owner");
    const status = c.req.query("status") ?? "open";
    if (owner && !(OWNERS as readonly string[]).includes(owner)) throw badRequest(`"owner" must be one of: ${OWNERS.join(", ")}`);
    if (!["open", "done", "all"].includes(status)) throw badRequest('"status" must be open, done or all');
    const out = [];
    for (const surgery of await store.listSurgeries()) {
      const patient = await store.getPatient(surgery.patientId);
      for (const task of await store.listTasks(surgery.id)) {
        if (owner && task.owner !== owner) continue;
        if (status !== "all" && task.status !== status) continue;
        out.push({ ...task, patientName: patient?.displayName ?? "", procedureName: surgery.procedureName, scheduledAt: surgery.scheduledAt });
      }
    }
    out.sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt) || a.createdAt.localeCompare(b.createdAt));
    return c.json({ tasks: out });
  });

  app.post("/tasks", async (c) => {
    const actor = can(c, "task_write");
    const body = await readJsonObject(c);
    return c.json({ task: await createTaskFromBody(store, body, actor) }, 201);
  });

  app.post("/tasks/:id/actions", async (c) => {
    const actor = can(c, "task_write");
    const body = await readJsonObject(c);
    return c.json({ task: await applyTaskAction(store, clock.now(), c.req.param("id"), body, actor) });
  });

  app.post("/messages/inbound", async (c) => {
    const input = parseInbound(await readJsonObject(c));
    // Only the adapter may speak for iMessage; staff can only simulate the patient.
    can(c, input.channel === "imessage" ? "inbound_imessage" : "inbound_simulated");
    // A text from an on-call staff phone is an acknowledgement, not a patient message.
    if (input.channel === "imessage" && input.phone && deps.escalation) {
      const staff = await deps.escalation.handleStaffReply(input.phone, input.body);
      if (staff.handled) {
        return c.json({ surgeryId: staff.surgeryId, messageId: null, classification: null, replies: staff.replies, effects: [] });
      }
    }
    try {
      return c.json(await deps.handleInbound(input));
    } catch (err) {
      if (err instanceof UnknownSenderError) throw new HttpError(404, "unknown_sender", err.message);
      throw err;
    }
  });

  app.get("/outbox", async (c) => {
    can(c, "outbox");
    const channel = c.req.query("channel") ?? "imessage";
    if (!(CHANNELS as readonly string[]).includes(channel)) {
      throw badRequest(`"channel" must be one of: ${CHANNELS.join(", ")}`);
    }
    const messages = await store.listOutbox(channel as (typeof CHANNELS)[number]);
    const phones = new Map<string, string | null>();
    for (const m of messages) {
      if (!phones.has(m.patientId)) phones.set(m.patientId, (await store.getPatient(m.patientId))?.phone ?? null);
    }
    const out: Array<Record<string, unknown>> = messages.map((m) => ({ ...m, phone: phones.get(m.patientId) ?? null }));
    // Staff alert texts ride the same outbox, so the adapter sends, retries and reports them unchanged.
    if (channel === "imessage" && deps.alerts) {
      for (const n of await deps.alerts.queuedNotifications()) {
        out.push({ id: n.id, alertId: n.alertId, direction: "out", channel: "imessage", body: n.body, attachments: [], deliveryStatus: "queued", createdAt: n.createdAt, phone: n.phone });
      }
    }
    return c.json({ messages: out });
  });

  app.post("/outbox/:id/sent", async (c) => {
    can(c, "outbox");
    const id = c.req.param("id");
    if (id.startsWith("ntf_") && deps.alerts) {
      return c.json({ notification: await deps.alerts.updateNotification(id, { deliveryStatus: "sent", deliveryError: null }) });
    }
    const message = await store.getMessage(id);
    if (!message) throw notFound("message", id);
    if (message.direction !== "out") throw invalidTransition("Only outbound messages can be marked sent");
    return c.json({ message: await store.updateMessage(id, { deliveryStatus: "sent" }) });
  });

  app.post("/outbox/:id/failed", async (c) => {
    can(c, "outbox");
    const id = c.req.param("id");
    const body = await readJsonObject(c);
    const error = optionalString(body, "error")?.trim().slice(0, 500) || "Delivery failed";
    if (id.startsWith("ntf_") && deps.alerts) {
      const notification = await deps.alerts.updateNotification(id, { deliveryStatus: "failed", deliveryError: error });
      const alert = await deps.alerts.getAlert(notification.alertId);
      if (alert) {
        await store.addEvent({
          surgeryId: alert.surgeryId,
          type: "alert_notification_failed",
          summary: `An urgent alert text could not be delivered: ${error}. It will escalate to the next person on schedule.`,
          actor: "imessage",
          data: { alertId: alert.id, notificationId: id, error },
        });
      }
      return c.json({ notification });
    }
    const message = await store.getMessage(id);
    if (!message) throw notFound("message", id);
    if (message.direction !== "out" || message.deliveryStatus !== "queued") {
      throw invalidTransition("Only a queued outbound message can be marked failed");
    }
    const updated = await store.updateMessage(id, { deliveryStatus: "failed", deliveryError: error });
    await store.addEvent({
      surgeryId: message.surgeryId,
      type: "message_failed",
      summary: `A message to the patient could not be delivered: ${error}`,
      actor: actorFor(c.get("identity")) ?? "imessage",
      data: { messageId: id, error },
    });
    return c.json({ message: updated });
  });

  app.post("/messages/:id/retry", async (c) => {
    const actor = can(c, "outreach_retry");
    const id = c.req.param("id");
    const message = await store.getMessage(id);
    if (!message) throw notFound("message", id);
    if (message.deliveryStatus !== "failed") throw invalidTransition("Only a failed message can be retried");
    const body = await readJsonObject(c).catch(() => ({}) as Body);
    const who = actor ?? optionalString(body, "actor")?.trim() ?? "staff";
    const updated = await store.updateMessage(id, { deliveryStatus: "queued", deliveryError: null });
    await store.addEvent({
      surgeryId: message.surgeryId,
      type: "message_retried",
      summary: `${who} queued a failed message to the patient again.`,
      actor: who,
      data: { messageId: id },
    });
    return c.json({ message: updated });
  });

  app.get("/alerts", async (c) => {
    can(c, "read");
    if (!deps.escalation || !deps.alerts) return c.json({ alerts: [] });
    const activeOnly = c.req.query("status") !== "all";
    const list = await deps.alerts.listAlerts({ activeOnly });
    return c.json({ alerts: await Promise.all(list.map((a) => deps.escalation!.view(a))) });
  });

  app.post("/alerts/:id/acknowledge", async (c) => {
    const actor = can(c, "alert_ack");
    const { escalation } = requireAlerts();
    const body = await readJsonObject(c).catch(() => ({}) as Body);
    const who = actor ?? optionalString(body, "actor")?.trim() ?? "staff";
    const alert = await escalation.acknowledge(c.req.param("id"), who);
    return c.json({ alert: await escalation.view(alert) });
  });

  app.post("/alerts/:id/resolve", async (c) => {
    const actor = can(c, "alert_resolve");
    const { escalation } = requireAlerts();
    const body = await readJsonObject(c);
    const note = optionalString(body, "note")?.trim();
    if (!note) throw new HttpError(400, "note_required", "Say how the concern was resolved");
    const who = actor ?? optionalString(body, "actor")?.trim() ?? "staff";
    const alert = await escalation.resolve(c.req.param("id"), who, note);
    return c.json({ alert: await escalation.view(alert) });
  });

  app.get("/documents/:id/content", async (c) => {
    can(c, "read");
    const id = c.req.param("id");
    const content = await store.getDocumentContent(id);
    if (!content) throw notFound("document", id);
    const bytes = Uint8Array.from(Buffer.from(content.base64, "base64"));
    return new Response(bytes, { headers: { "Content-Type": content.mimeType } });
  });

  app.post("/demo/reset", async (c) => {
    can(c, "demo_reset");
    const seed = deps.seed();
    await store.reset(seed, clock.now());
    return c.json({ ok: true, surgeries: seed.surgeries.length });
  });

  app.notFound((c) => c.json({ error: { code: "not_found", message: `No route for ${c.req.method} ${c.req.path}` } }, 404));

  app.onError((err, c) => {
    if (err instanceof AuthError) {
      return c.json({ error: { code: err.status === 401 ? "unauthorized" : "forbidden", message: err.message } }, err.status);
    }
    if (err instanceof HttpError) {
      return c.json({ error: { code: err.code, message: err.message } }, err.status);
    }
    if (err instanceof AlertTransitionError) {
      return c.json({ error: { code: err.message.startsWith("No alert") ? "not_found" : "invalid_transition", message: err.message } }, err.message.startsWith("No alert") ? 404 : 409);
    }
    if (err instanceof NotFoundError) {
      return c.json({ error: { code: "not_found", message: err.message } }, 404);
    }
    // The record check signals an unreachable FinchNode with an error carrying this code.
    if ((err as { code?: unknown }).code === "upstream_failed") {
      return c.json({ error: { code: "upstream_failed", message: err.message } }, 502);
    }
    console.error("Unhandled error", err);
    return c.json({ error: { code: "internal", message: "Internal server error" } }, 500);
  });

  return app;
}
