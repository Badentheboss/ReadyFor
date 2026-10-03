import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { NotFoundError } from "../store/errors.ts";
import type { AppDeps, InboundAttachment, InboundInput } from "../types.ts";
import { UnknownSenderError } from "../types.ts";
import { applyRequirementAction, applyTaskAction, createTaskFromBody } from "./actions.ts";
import { briefText, buildDetail, buildSummary, requireSurgery } from "./detail.ts";
import { badRequest, HttpError, invalidTransition, notFound } from "./errors.ts";
import {
  CHANNELS,
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

export function createApp(deps: AppDeps): Hono {
  const { store, clock } = deps;
  const app = new Hono();

  app.use("*", cors());
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
    }),
  );

  app.get("/surgeries", async (c) => {
    const now = clock.now();
    const surgeries = await store.listSurgeries();
    return c.json({ surgeries: await Promise.all(surgeries.map((s) => buildSummary(store, s, now))) });
  });

  app.get("/surgeries/:id", async (c) => {
    const surgery = await requireSurgery(store, c.req.param("id"));
    return c.json(await buildDetail(store, surgery, clock.now()));
  });

  app.get("/surgeries/:id/brief", async (c) => {
    const surgery = await requireSurgery(store, c.req.param("id"));
    const detail = await buildDetail(store, surgery, clock.now());
    return c.json({
      text: briefText(detail.surgery, detail.patient, detail.readiness, detail.requirements, detail.tasks),
    });
  });

  app.post("/surgeries/:id/check", async (c) => {
    const surgery = await requireSurgery(store, c.req.param("id"));
    const result = await deps.runRecordCheck(surgery.id);
    const fresh = await requireSurgery(store, surgery.id);
    return c.json({ detail: await buildDetail(store, fresh, clock.now()), result });
  });

  app.post("/requirements/:id/actions", async (c) => {
    const body = await readJsonObject(c);
    return c.json(await applyRequirementAction(store, clock.now(), c.req.param("id"), body));
  });

  app.post("/tasks", async (c) => {
    const body = await readJsonObject(c);
    return c.json({ task: await createTaskFromBody(store, body) }, 201);
  });

  app.post("/tasks/:id/actions", async (c) => {
    const body = await readJsonObject(c);
    return c.json({ task: await applyTaskAction(store, clock.now(), c.req.param("id"), body) });
  });

  app.post("/messages/inbound", async (c) => {
    const input = parseInbound(await readJsonObject(c));
    try {
      return c.json(await deps.handleInbound(input));
    } catch (err) {
      if (err instanceof UnknownSenderError) throw new HttpError(404, "unknown_sender", err.message);
      throw err;
    }
  });

  app.get("/outbox", async (c) => {
    const channel = c.req.query("channel") ?? "imessage";
    if (!(CHANNELS as readonly string[]).includes(channel)) {
      throw badRequest(`"channel" must be one of: ${CHANNELS.join(", ")}`);
    }
    const messages = await store.listOutbox(channel as (typeof CHANNELS)[number]);
    const phones = new Map<string, string | null>();
    for (const m of messages) {
      if (!phones.has(m.patientId)) phones.set(m.patientId, (await store.getPatient(m.patientId))?.phone ?? null);
    }
    return c.json({ messages: messages.map((m) => ({ ...m, phone: phones.get(m.patientId) ?? null })) });
  });

  app.post("/outbox/:id/sent", async (c) => {
    const id = c.req.param("id");
    const message = await store.getMessage(id);
    if (!message) throw notFound("message", id);
    if (message.direction !== "out") throw invalidTransition("Only outbound messages can be marked sent");
    return c.json({ message: await store.updateMessage(id, { deliveryStatus: "sent" }) });
  });

  app.get("/documents/:id/content", async (c) => {
    const id = c.req.param("id");
    const content = await store.getDocumentContent(id);
    if (!content) throw notFound("document", id);
    const bytes = Uint8Array.from(Buffer.from(content.base64, "base64"));
    return new Response(bytes, { headers: { "Content-Type": content.mimeType } });
  });

  app.post("/demo/reset", async (c) => {
    const seed = deps.seed();
    await store.reset(seed, clock.now());
    return c.json({ ok: true, surgeries: seed.surgeries.length });
  });

  app.notFound((c) => c.json({ error: { code: "not_found", message: `No route for ${c.req.method} ${c.req.path}` } }, 404));

  app.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json({ error: { code: err.code, message: err.message } }, err.status);
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
