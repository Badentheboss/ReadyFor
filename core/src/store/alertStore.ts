/** SQL storage for the on-call ladder, urgent alerts and their notifications. Same database as sqlStore. */
import { newId } from "../ids.ts";
import type { Alert, AlertNotification, AlertStore, StaffContact } from "../types.ts";
import { NotFoundError } from "./errors.ts";
import type { Queryable } from "./sqlStore.ts";

const ALERT_COLS =
  "id, surgery_id, patient_id, kind, summary, message_id, status, level, notified_contact_id, notified_at, escalate_after, exhausted, acknowledged_by, acknowledged_at, resolved_by, resolved_at, resolution, created_at";
const NTF_COLS = "id, alert_id, contact_id, level, body, delivery_status, delivery_error, created_at";

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());
const isoOrNull = (v: unknown): string | null => (v == null ? null : iso(v));
const digits = (s: string) => s.replace(/\D/g, "");

const toContact = (r: any): StaffContact => ({
  id: r.id,
  name: r.name,
  role: r.role,
  phone: r.phone ?? null,
  onCallRank: Number(r.on_call_rank),
  active: r.active,
});

const toAlert = (r: any): Alert => ({
  id: r.id,
  surgeryId: r.surgery_id,
  patientId: r.patient_id,
  kind: r.kind,
  summary: r.summary,
  messageId: r.message_id ?? null,
  status: r.status,
  level: Number(r.level),
  notifiedContactId: r.notified_contact_id ?? null,
  notifiedAt: isoOrNull(r.notified_at),
  escalateAfter: isoOrNull(r.escalate_after),
  exhausted: r.exhausted,
  acknowledgedBy: r.acknowledged_by ?? null,
  acknowledgedAt: isoOrNull(r.acknowledged_at),
  resolvedBy: r.resolved_by ?? null,
  resolvedAt: isoOrNull(r.resolved_at),
  resolution: r.resolution ?? null,
  createdAt: iso(r.created_at),
});

const toNotification = (r: any): AlertNotification => ({
  id: r.id,
  alertId: r.alert_id,
  contactId: r.contact_id,
  level: Number(r.level),
  body: r.body,
  deliveryStatus: r.delivery_status,
  deliveryError: r.delivery_error ?? null,
  createdAt: iso(r.created_at),
});

const ALERT_PATCH: Record<string, string> = {
  status: "status",
  level: "level",
  notifiedContactId: "notified_contact_id",
  notifiedAt: "notified_at",
  escalateAfter: "escalate_after",
  exhausted: "exhausted",
  acknowledgedBy: "acknowledged_by",
  acknowledgedAt: "acknowledged_at",
  resolvedBy: "resolved_by",
  resolvedAt: "resolved_at",
  resolution: "resolution",
  summary: "summary",
};

/** Resolves "env:NAME" seed phones; empty or unset variables become null. */
function resolvePhone(phone: string | null): string | null {
  if (phone == null) return null;
  if (!phone.startsWith("env:")) return phone;
  return process.env[phone.slice(4)]?.trim() || null;
}

export function createAlertStore(db: Queryable): AlertStore {
  let lastStamp = 0;
  const stamp = () => {
    lastStamp = Math.max(Date.now(), lastStamp + 1);
    return new Date(lastStamp).toISOString();
  };
  const rows = async (text: string, params: unknown[] = []) => (await db.query(text, params)).rows as any[];
  const first = async (text: string, params: unknown[] = []) => (await rows(text, params))[0] ?? null;

  const store: AlertStore = {
    async listContacts() {
      return (await rows("SELECT * FROM staff_contacts WHERE active ORDER BY on_call_rank, id")).map(toContact);
    },

    async upsertContact(c) {
      await db.query(
        `INSERT INTO staff_contacts (id, name, role, phone, on_call_rank, active) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO UPDATE SET name = $2, role = $3, phone = $4, on_call_rank = $5, active = $6`,
        [c.id, c.name, c.role, c.phone, c.onCallRank, c.active],
      );
    },

    async findContactByPhone(phone) {
      const want = digits(phone).slice(-10);
      if (want.length < 7) return null;
      const all = (await rows("SELECT * FROM staff_contacts WHERE active AND phone IS NOT NULL")).map(toContact);
      return all.find((c) => digits(c.phone!).slice(-10) === want) ?? null;
    },

    async createAlert(input) {
      const row = await first(
        `INSERT INTO alerts (id, surgery_id, patient_id, kind, summary, message_id, status, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'open', $7) RETURNING ${ALERT_COLS}`,
        [newId("alr"), input.surgeryId, input.patientId, input.kind, input.summary, input.messageId, stamp()],
      );
      return toAlert(row);
    },

    async getAlert(id) {
      const row = await first(`SELECT ${ALERT_COLS} FROM alerts WHERE id = $1`, [id]);
      return row ? toAlert(row) : null;
    },

    async listAlerts(filter = {}) {
      const where: string[] = [];
      const params: unknown[] = [];
      if (filter.surgeryId) {
        params.push(filter.surgeryId);
        where.push(`surgery_id = $${params.length}`);
      }
      if (filter.activeOnly) where.push("status <> 'resolved'");
      const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
      return (await rows(`SELECT ${ALERT_COLS} FROM alerts ${clause} ORDER BY created_at DESC, id`, params)).map(toAlert);
    },

    async updateAlert(id, patch) {
      const params: unknown[] = [id];
      const sets: string[] = [];
      for (const [key, value] of Object.entries(patch)) {
        const column = ALERT_PATCH[key];
        if (!column || value === undefined) continue;
        params.push(value);
        sets.push(`${column} = $${params.length}`);
      }
      const row = sets.length
        ? await first(`UPDATE alerts SET ${sets.join(", ")} WHERE id = $1 RETURNING ${ALERT_COLS}`, params)
        : await first(`SELECT ${ALERT_COLS} FROM alerts WHERE id = $1`, [id]);
      if (!row) throw new NotFoundError("alert", id);
      return toAlert(row);
    },

    async dueAlerts(now) {
      return (
        await rows(
          `SELECT ${ALERT_COLS} FROM alerts WHERE status = 'open' AND escalate_after IS NOT NULL AND escalate_after <= $1
           ORDER BY escalate_after, id`,
          [now.toISOString()],
        )
      ).map(toAlert);
    },

    async createNotification(input) {
      const row = await first(
        `INSERT INTO alert_notifications (id, alert_id, contact_id, level, body, delivery_status, delivery_error, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${NTF_COLS}`,
        [newId("ntf"), input.alertId, input.contactId, input.level, input.body, input.deliveryStatus, input.deliveryError, stamp()],
      );
      return toNotification(row);
    },

    async getNotification(id) {
      const row = await first(`SELECT ${NTF_COLS} FROM alert_notifications WHERE id = $1`, [id]);
      return row ? toNotification(row) : null;
    },

    async listNotifications(alertId) {
      return (
        await rows(`SELECT ${NTF_COLS} FROM alert_notifications WHERE alert_id = $1 ORDER BY created_at, id`, [alertId])
      ).map(toNotification);
    },

    async queuedNotifications() {
      return (
        await rows(
          `SELECT n.id, n.alert_id, n.contact_id, n.level, n.body, n.delivery_status, n.delivery_error, n.created_at, c.phone
           FROM alert_notifications n JOIN staff_contacts c ON c.id = n.contact_id
           WHERE n.delivery_status = 'queued' ORDER BY n.created_at, n.id`,
        )
      ).map((r) => ({ ...toNotification(r), phone: r.phone ?? null }));
    },

    async updateNotification(id, patch) {
      const row = await first(
        `UPDATE alert_notifications SET delivery_status = $2, delivery_error = $3 WHERE id = $1 RETURNING ${NTF_COLS}`,
        [id, patch.deliveryStatus, patch.deliveryError],
      );
      if (!row) throw new NotFoundError("notification", id);
      return toNotification(row);
    },

    async syncSeedPhones(seed) {
      for (const s of seed.staff ?? []) {
        await store.upsertContact({ id: s.id, name: s.name, role: s.role, phone: resolvePhone(s.phone), onCallRank: s.onCallRank, active: true });
      }
      for (const p of seed.patients) {
        if (p.phone?.startsWith("env:")) {
          await db.query("UPDATE patients SET phone = $2 WHERE id = $1", [p.id, resolvePhone(p.phone)]);
        }
      }
    },
  };
  return store;
}
