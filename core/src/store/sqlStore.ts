import { newId } from "../ids.ts";
import type {
  AttachmentMeta,
  Channel,
  Classification,
  DocumentRecord,
  EventRecord,
  Message,
  NewDocument,
  NewEvent,
  NewMessage,
  NewTask,
  Patient,
  Requirement,
  RequirementPatch,
  RequirementUpsert,
  SeedData,
  Store,
  Surgery,
  Task,
  TaskPatch,
} from "../types.ts";
import { NotFoundError } from "./errors.ts";

export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: any[] }>;
  exec?(text: string): Promise<unknown>;
}

// Column lists. Dates are formatted in SQL so every driver returns the same thing,
// and document bytes are never selected unless asked for.
const PATIENT_COLS = "id, finchnode_subject, display_name, phone, to_char(birth_date, 'YYYY-MM-DD') AS birth_date, created_at";
const SURGERY_COLS =
  "id, patient_id, procedure_code, procedure_name, scheduled_at, location, surgeon, status, last_checked_at, created_at";
const REQ_COLS =
  "id, surgery_id, key, title, kind, status, blocking, owner, reason, source, proposal, evidence, verified_by, verified_at, staff_note, outreach_message_id, created_at, updated_at";
const TASK_COLS = "id, surgery_id, requirement_id, title, detail, owner, status, origin, created_at, completed_at, completed_by";
const MSG_COLS = "id, surgery_id, patient_id, direction, channel, body, attachments, classification, delivery_status, delivery_error, created_at";
const DOC_COLS = "id, surgery_id, requirement_id, message_id, mime_type, extracted, status, created_at";
const EVENT_COLS = "id, surgery_id, type, summary, actor, data, created_at";

function iso(value: unknown): string {
  return new Date(value as string | number | Date).toISOString();
}

function isoOrNull(value: unknown): string | null {
  return value == null ? null : iso(value);
}

function parseJson<T>(value: unknown): T | null {
  if (value == null) return null;
  return (typeof value === "string" ? JSON.parse(value) : value) as T;
}

function toJson(value: unknown): string | null {
  return value == null ? null : JSON.stringify(value);
}

const toPatient = (r: any): Patient => ({
  id: r.id,
  finchnodeSubject: r.finchnode_subject ?? null,
  displayName: r.display_name,
  phone: r.phone ?? null,
  birthDate: r.birth_date ?? null,
  createdAt: iso(r.created_at),
});

const toSurgery = (r: any): Surgery => ({
  id: r.id,
  patientId: r.patient_id,
  procedureCode: r.procedure_code,
  procedureName: r.procedure_name,
  scheduledAt: iso(r.scheduled_at),
  location: r.location,
  surgeon: r.surgeon,
  status: r.status,
  lastCheckedAt: isoOrNull(r.last_checked_at),
  createdAt: iso(r.created_at),
});

const toRequirement = (r: any): Requirement => ({
  id: r.id,
  surgeryId: r.surgery_id,
  key: r.key,
  title: r.title,
  kind: r.kind,
  status: r.status,
  blocking: r.blocking,
  owner: r.owner,
  reason: r.reason,
  source: parseJson(r.source),
  proposal: parseJson(r.proposal),
  evidence: parseJson(r.evidence),
  verifiedBy: r.verified_by ?? null,
  verifiedAt: isoOrNull(r.verified_at),
  staffNote: r.staff_note ?? null,
  outreachMessageId: r.outreach_message_id ?? null,
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});

const toTask = (r: any): Task => ({
  id: r.id,
  surgeryId: r.surgery_id,
  requirementId: r.requirement_id ?? null,
  title: r.title,
  detail: r.detail,
  owner: r.owner,
  status: r.status,
  origin: r.origin,
  createdAt: iso(r.created_at),
  completedAt: isoOrNull(r.completed_at),
  completedBy: r.completed_by ?? null,
});

const toMessage = (r: any): Message => ({
  id: r.id,
  surgeryId: r.surgery_id,
  patientId: r.patient_id,
  direction: r.direction,
  channel: r.channel,
  body: r.body,
  attachments: parseJson<AttachmentMeta[]>(r.attachments) ?? [],
  classification: parseJson<Classification>(r.classification),
  deliveryStatus: r.delivery_status,
  deliveryError: r.delivery_error ?? null,
  createdAt: iso(r.created_at),
});

const toDocument = (r: any): DocumentRecord => ({
  id: r.id,
  surgeryId: r.surgery_id,
  requirementId: r.requirement_id ?? null,
  messageId: r.message_id ?? null,
  mimeType: r.mime_type,
  extracted: parseJson(r.extracted),
  status: r.status,
  createdAt: iso(r.created_at),
});

const toEvent = (r: any): EventRecord => ({
  id: r.id,
  surgeryId: r.surgery_id,
  type: r.type,
  summary: r.summary,
  actor: r.actor,
  data: parseJson(r.data),
  createdAt: iso(r.created_at),
});

interface PatchColumn {
  column: string;
  json?: boolean;
}

/**
 * Builds "col = $n" assignments for the keys present in `patch`. A key set to null
 * is written as null; a key that is missing or undefined is left alone.
 * `params` already holds the leading parameters (the id).
 */
function patchAssignments(patch: object, columns: Record<string, PatchColumn>, params: unknown[]): string[] {
  const values = patch as Record<string, unknown>;
  const sets: string[] = [];
  for (const [key, { column, json }] of Object.entries(columns)) {
    const value = values[key];
    if (value === undefined) continue;
    params.push(json ? toJson(value) : value);
    sets.push(`${column} = $${params.length}${json ? "::jsonb" : ""}`);
  }
  return sets;
}

const REQUIREMENT_PATCH_COLUMNS: Record<string, PatchColumn> = {
  title: { column: "title" },
  status: { column: "status" },
  blocking: { column: "blocking" },
  owner: { column: "owner" },
  reason: { column: "reason" },
  source: { column: "source", json: true },
  proposal: { column: "proposal", json: true },
  evidence: { column: "evidence", json: true },
  verifiedBy: { column: "verified_by" },
  verifiedAt: { column: "verified_at" },
  staffNote: { column: "staff_note" },
  outreachMessageId: { column: "outreach_message_id" },
};

const TASK_PATCH_COLUMNS: Record<string, PatchColumn> = {
  owner: { column: "owner" },
  status: { column: "status" },
  completedAt: { column: "completed_at" },
  completedBy: { column: "completed_by" },
  detail: { column: "detail" },
};

const MESSAGE_PATCH_COLUMNS: Record<string, PatchColumn> = {
  deliveryStatus: { column: "delivery_status" },
  deliveryError: { column: "delivery_error" },
  classification: { column: "classification", json: true },
  attachments: { column: "attachments", json: true },
};

const DOCUMENT_PATCH_COLUMNS: Record<string, PatchColumn> = {
  requirementId: { column: "requirement_id" },
  extracted: { column: "extracted", json: true },
  status: { column: "status" },
};

const SURGERY_PATCH_COLUMNS: Record<string, PatchColumn> = {
  status: { column: "status" },
  lastCheckedAt: { column: "last_checked_at" },
};

const digitsOnly = (s: string) => s.replace(/\D/g, "");

/**
 * Normalises a US number to E.164: 10 digits get +1, 11 digits starting with 1 get +.
 * Anything else is left as written. "+2485550123" (country code forgotten) becomes "+12485550123".
 */
export function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return phone.trim();
}

/** Resolves "env:NAME" seed phones; empty or unset variables become null. */
function resolveSeedPhone(phone: string | null): string | null {
  if (phone == null) return null;
  if (!phone.startsWith("env:")) return normalizePhone(phone);
  const value = process.env[phone.slice(4)]?.trim();
  return value ? normalizePhone(value) : null;
}

function scheduledAtFor(now: Date, daysFromNow: number, timeOfDay: string): Date {
  const [hh = "0", mm = "0"] = timeOfDay.split(":");
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysFromNow, Number(hh), Number(mm)),
  );
}

export function createSqlStore(db: Queryable): Store {
  // created_at and updated_at come from here, not from SQL now(): PGlite's clock only has
  // millisecond resolution, so rows written back to back could tie and list out of order.
  let lastStamp = 0;
  function stamp(): string {
    lastStamp = Math.max(Date.now(), lastStamp + 1);
    return new Date(lastStamp).toISOString();
  }

  async function rows(text: string, params: unknown[] = []): Promise<any[]> {
    return (await db.query(text, params)).rows;
  }

  async function first(text: string, params: unknown[] = []): Promise<any | null> {
    return (await rows(text, params))[0] ?? null;
  }

  /** Runs an UPDATE ... RETURNING and throws not_found when no row matched. */
  async function update(
    table: string,
    cols: string,
    what: string,
    id: string,
    patch: object,
    columns: Record<string, PatchColumn>,
    bumpUpdatedAt = false,
  ): Promise<any> {
    const params: unknown[] = [id];
    const sets = patchAssignments(patch, columns, params);
    if (bumpUpdatedAt) {
      params.push(stamp());
      sets.push(`updated_at = $${params.length}`);
    }
    if (sets.length === 0) {
      const row = await first(`SELECT ${cols} FROM ${table} WHERE id = $1`, [id]);
      if (!row) throw new NotFoundError(what, id);
      return row;
    }
    const row = await first(`UPDATE ${table} SET ${sets.join(", ")} WHERE id = $1 RETURNING ${cols}`, params);
    if (!row) throw new NotFoundError(what, id);
    return row;
  }

  async function insertRequirement(input: RequirementUpsert, createdAt?: Date): Promise<Requirement> {
    const created = createdAt ? createdAt.toISOString() : stamp();
    const row = await first(
      `INSERT INTO requirements
         (id, surgery_id, key, title, kind, status, blocking, owner, reason, source, proposal, evidence, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12::jsonb, $13, $14)
       ON CONFLICT (surgery_id, key) DO UPDATE SET
         title = EXCLUDED.title,
         kind = EXCLUDED.kind,
         status = EXCLUDED.status,
         blocking = EXCLUDED.blocking,
         owner = EXCLUDED.owner,
         reason = EXCLUDED.reason,
         source = EXCLUDED.source,
         proposal = EXCLUDED.proposal,
         evidence = EXCLUDED.evidence,
         verified_by = NULL,
         verified_at = NULL,
         staff_note = NULL,
         updated_at = EXCLUDED.updated_at
       RETURNING ${REQ_COLS}`,
      [
        newId("req"),
        input.surgeryId,
        input.key,
        input.title,
        input.kind,
        input.status,
        input.blocking,
        input.owner,
        input.reason,
        toJson(input.source),
        toJson(input.proposal),
        toJson(input.evidence),
        created,
        created,
      ],
    );
    return toRequirement(row);
  }

  const store: Store = {
    async reset(seed: SeedData, now: Date) {
      await db.query(
        "TRUNCATE events, documents, messages, tasks, requirements, surgeries, patients CASCADE",
      );
      const nowIso = now.toISOString();
      for (const p of seed.patients) {
        await db.query(
          `INSERT INTO patients (id, finchnode_subject, display_name, phone, birth_date, created_at)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [p.id, p.finchnodeSubject, p.displayName, resolveSeedPhone(p.phone), p.birthDate, nowIso],
        );
      }
      for (const s of seed.surgeries) {
        await db.query(
          `INSERT INTO surgeries
             (id, patient_id, procedure_code, procedure_name, scheduled_at, location, surgeon, status, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'scheduled', $8)`,
          [
            s.id,
            s.patientId,
            s.procedureCode,
            s.procedureName,
            scheduledAtFor(now, s.daysFromNow, s.timeOfDay).toISOString(),
            s.location,
            s.surgeon,
            nowIso,
          ],
        );
        // One millisecond apart so the seeded order is the order they list in.
        let offset = 0;
        for (const { verifiedBy, staffNote, ...input } of s.requirements ?? []) {
          const created = await insertRequirement(
            { ...input, surgeryId: s.id },
            new Date(now.getTime() + offset++),
          );
          if (verifiedBy) {
            await store.updateRequirement(created.id, {
              verifiedBy,
              verifiedAt: nowIso,
              staffNote: staffNote ?? null,
            });
          }
        }
      }
    },

    async listSurgeries() {
      return (await rows(`SELECT ${SURGERY_COLS} FROM surgeries ORDER BY scheduled_at, id`)).map(toSurgery);
    },

    async getSurgery(id) {
      const row = await first(`SELECT ${SURGERY_COLS} FROM surgeries WHERE id = $1`, [id]);
      return row ? toSurgery(row) : null;
    },

    async updateSurgery(id, patch) {
      return toSurgery(await update("surgeries", SURGERY_COLS, "surgery", id, patch, SURGERY_PATCH_COLUMNS));
    },

    async getPatient(id) {
      const row = await first(`SELECT ${PATIENT_COLS} FROM patients WHERE id = $1`, [id]);
      return row ? toPatient(row) : null;
    },

    async findPatientByPhone(phone) {
      // Compare the last 10 digits, so "+1 248…" from iMessage matches "248…" or "+1248…" on file.
      const digits = digitsOnly(phone).slice(-10);
      if (digits.length < 7) return null;
      const row = await first(
        `SELECT ${PATIENT_COLS} FROM patients
         WHERE right(regexp_replace(phone, '\\D', '', 'g'), 10) = $1
         ORDER BY created_at, id LIMIT 1`,
        [digits],
      );
      return row ? toPatient(row) : null;
    },

    async nextSurgeryForPatient(patientId, now) {
      const row = await first(
        `SELECT ${SURGERY_COLS} FROM surgeries
         WHERE patient_id = $1 AND status = 'scheduled' AND scheduled_at >= $2
         ORDER BY scheduled_at, id LIMIT 1`,
        [patientId, now.toISOString()],
      );
      return row ? toSurgery(row) : null;
    },

    async listRequirements(surgeryId) {
      return (
        await rows(`SELECT ${REQ_COLS} FROM requirements WHERE surgery_id = $1 ORDER BY created_at, id`, [surgeryId])
      ).map(toRequirement);
    },

    async getRequirement(id) {
      const row = await first(`SELECT ${REQ_COLS} FROM requirements WHERE id = $1`, [id]);
      return row ? toRequirement(row) : null;
    },

    async getRequirementByKey(surgeryId, key) {
      const row = await first(`SELECT ${REQ_COLS} FROM requirements WHERE surgery_id = $1 AND key = $2`, [
        surgeryId,
        key,
      ]);
      return row ? toRequirement(row) : null;
    },

    upsertRequirement: (input) => insertRequirement(input),

    async updateRequirement(id, patch: RequirementPatch) {
      return toRequirement(
        await update("requirements", REQ_COLS, "requirement", id, patch, REQUIREMENT_PATCH_COLUMNS, true),
      );
    },

    async listTasks(surgeryId) {
      return (await rows(`SELECT ${TASK_COLS} FROM tasks WHERE surgery_id = $1 ORDER BY created_at, id`, [surgeryId])).map(
        toTask,
      );
    },

    async getTask(id) {
      const row = await first(`SELECT ${TASK_COLS} FROM tasks WHERE id = $1`, [id]);
      return row ? toTask(row) : null;
    },

    async createTask(input: NewTask) {
      const row = await first(
        `INSERT INTO tasks (id, surgery_id, requirement_id, title, detail, owner, status, origin, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'open', $7, $8)
         RETURNING ${TASK_COLS}`,
        [newId("tsk"), input.surgeryId, input.requirementId ?? null, input.title, input.detail ?? "", input.owner, input.origin, stamp()],
      );
      return toTask(row);
    },

    async updateTask(id, patch: TaskPatch) {
      return toTask(await update("tasks", TASK_COLS, "task", id, patch, TASK_PATCH_COLUMNS));
    },

    async listMessages(surgeryId) {
      return (
        await rows(`SELECT ${MSG_COLS} FROM messages WHERE surgery_id = $1 ORDER BY created_at, id`, [surgeryId])
      ).map(toMessage);
    },

    async getMessage(id) {
      const row = await first(`SELECT ${MSG_COLS} FROM messages WHERE id = $1`, [id]);
      return row ? toMessage(row) : null;
    },

    async createMessage(input: NewMessage) {
      const row = await first(
        `INSERT INTO messages
           (id, surgery_id, patient_id, direction, channel, body, attachments, classification, delivery_status, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10)
         RETURNING ${MSG_COLS}`,
        [
          newId("msg"),
          input.surgeryId,
          input.patientId,
          input.direction,
          input.channel,
          input.body,
          JSON.stringify(input.attachments ?? []),
          toJson(input.classification),
          input.deliveryStatus,
          stamp(),
        ],
      );
      return toMessage(row);
    },

    async updateMessage(id, patch) {
      return toMessage(await update("messages", MSG_COLS, "message", id, patch, MESSAGE_PATCH_COLUMNS));
    },

    async listOutbox(channel: Channel) {
      return (
        await rows(
          `SELECT ${MSG_COLS} FROM messages
           WHERE direction = 'out' AND delivery_status = 'queued' AND channel = $1
           ORDER BY created_at, id`,
          [channel],
        )
      ).map(toMessage);
    },

    async listDocuments(surgeryId) {
      return (
        await rows(`SELECT ${DOC_COLS} FROM documents WHERE surgery_id = $1 ORDER BY created_at, id`, [surgeryId])
      ).map(toDocument);
    },

    async getDocument(id) {
      const row = await first(`SELECT ${DOC_COLS} FROM documents WHERE id = $1`, [id]);
      return row ? toDocument(row) : null;
    },

    async createDocument(input: NewDocument) {
      const row = await first(
        `INSERT INTO documents
           (id, surgery_id, requirement_id, message_id, mime_type, content_base64, extracted, status, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
         RETURNING ${DOC_COLS}`,
        [
          newId("doc"),
          input.surgeryId,
          input.requirementId ?? null,
          input.messageId ?? null,
          input.mimeType,
          input.base64,
          toJson(input.extracted),
          input.status,
          stamp(),
        ],
      );
      return toDocument(row);
    },

    async updateDocument(id, patch) {
      return toDocument(await update("documents", DOC_COLS, "document", id, patch, DOCUMENT_PATCH_COLUMNS));
    },

    async getDocumentContent(id) {
      const row = await first("SELECT mime_type, content_base64 FROM documents WHERE id = $1", [id]);
      return row ? { mimeType: row.mime_type, base64: row.content_base64 } : null;
    },

    async listEvents(surgeryId, limit) {
      const params: unknown[] = [surgeryId];
      let sql = `SELECT ${EVENT_COLS} FROM events WHERE surgery_id = $1 ORDER BY created_at DESC, id DESC`;
      if (limit !== undefined) {
        params.push(limit);
        sql += ` LIMIT $2`;
      }
      return (await rows(sql, params)).map(toEvent);
    },

    async addEvent(input: NewEvent) {
      const row = await first(
        `INSERT INTO events (id, surgery_id, type, summary, actor, data, created_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
         RETURNING ${EVENT_COLS}`,
        [newId("evt"), input.surgeryId, input.type, input.summary, input.actor, toJson(input.data), stamp()],
      );
      return toEvent(row);
    },
  };

  return store;
}
