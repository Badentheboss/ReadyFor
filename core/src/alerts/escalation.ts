/**
 * Urgent escalation. A patient-reported symptom raises an alert; the first person on the
 * on-call ladder is texted; if nobody acknowledges within `escalateAfterMs`, the next person
 * is texted, and so on. Acknowledging (dashboard or an "ACK" reply) stops the clock and tells
 * the patient who has it. Every step is written to the surgery's event history.
 */
import type { Alert, AlertStore, AlertView, ClinicInfo, Clock, StaffContact, Store } from "../types.ts";

export interface Escalation {
  raise(input: { surgeryId: string; summary: string; messageId: string | null }): Promise<Alert>;
  /** Moves every overdue alert to the next person. Returns how many moved. */
  tick(): Promise<number>;
  acknowledge(alertId: string, actor: string, by?: StaffContact): Promise<Alert>;
  resolve(alertId: string, actor: string, note: string): Promise<Alert>;
  /** Handles a text from a staff phone. `handled: false` means the phone is not a staff contact. */
  handleStaffReply(phone: string, text: string): Promise<{ handled: boolean; replies: string[]; surgeryId: string | null }>;
  view(alert: Alert): Promise<AlertView>;
}

export class AlertTransitionError extends Error {}

const ACK = /^\s*(ack|ok|okay|yes|y|on it|got it|taking it|mine|accept|accepted)\b/i;

/** "nurse:Priya Shah" -> "Priya Shah"; "nurse:Priya via ASI:One" -> "Priya". */
function displayName(actor: string): string {
  const name = actor.includes(":") ? actor.slice(actor.indexOf(":") + 1) : actor;
  return name.replace(/\s+via\s+.*$/i, "").trim() || "Someone";
}

export function createEscalation(deps: {
  store: Store;
  alerts: AlertStore;
  clock: Clock;
  clinic: ClinicInfo;
  escalateAfterMs: number;
}): Escalation {
  const { store, alerts, clock, clinic, escalateAfterMs } = deps;

  async function event(alert: Alert, type: string, summary: string, actor: string, data: Record<string, unknown> = {}) {
    await store.addEvent({ surgeryId: alert.surgeryId, type, summary, actor, data: { alertId: alert.id, ...data } });
  }

  async function describePatient(alert: Alert) {
    const [surgery, patient] = await Promise.all([store.getSurgery(alert.surgeryId), store.getPatient(alert.patientId)]);
    const date = surgery
      ? new Date(surgery.scheduledAt).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" })
      : "";
    return {
      name: patient?.displayName ?? "A patient",
      first: (patient?.displayName ?? "there").split(" ")[0]!,
      line: `${patient?.displayName ?? "A patient"} (${surgery?.procedureName ?? "surgery"}, ${date})`,
    };
  }

  /** Texts the person at `level` on the ladder, or marks the ladder exhausted. */
  async function notify(alert: Alert, level: number): Promise<Alert> {
    const now = clock.now();
    const ladder = await alerts.listContacts();
    const contact = ladder[level];
    if (!contact) {
      const updated = await alerts.updateAlert(alert.id, { escalateAfter: null, exhausted: true });
      await event(
        updated,
        "alert_unanswered",
        `Nobody on the on-call list has acknowledged the urgent alert. Reach coverage directly at ${clinic.phone}.`,
        "system",
      );
      return updated;
    }
    const who = await describePatient(alert);
    const body = `URGENT · ${clinic.name}: ${who.line} reported: "${alert.summary}". Reply ACK to take it, or open ReadyFor.`.slice(0, 480);
    await alerts.createNotification({
      alertId: alert.id,
      contactId: contact.id,
      level,
      body,
      deliveryStatus: contact.phone ? "queued" : "failed",
      deliveryError: contact.phone ? null : "No phone number on file for this contact",
    });
    const updated = await alerts.updateAlert(alert.id, {
      level,
      notifiedContactId: contact.id,
      notifiedAt: now.toISOString(),
      escalateAfter: new Date(now.getTime() + escalateAfterMs).toISOString(),
    });
    await event(
      updated,
      level === 0 ? "alert_notified" : "alert_escalated",
      `Urgent alert ${level === 0 ? "sent to" : "escalated to"} ${contact.name} (${contact.role}, on-call #${level + 1})${contact.phone ? "" : "; no phone on file"}.`,
      "system",
      { contactId: contact.id, level },
    );
    return updated;
  }

  const escalation: Escalation = {
    async raise({ surgeryId, summary, messageId }) {
      const surgery = await store.getSurgery(surgeryId);
      if (!surgery) throw new Error(`No surgery ${surgeryId}`);
      // One live alert per surgery: a second symptom message joins it instead of paging again.
      const live = (await alerts.listAlerts({ surgeryId, activeOnly: true }))[0];
      if (live) {
        await event(live, "alert_updated", `Patient sent more about the urgent concern: ${summary}`, "patient", { messageId });
        return live;
      }
      const alert = await alerts.createAlert({ surgeryId, patientId: surgery.patientId, kind: "health_concern", summary, messageId });
      await event(alert, "alert_raised", `Urgent: patient reported "${summary}".`, "patient", { messageId });
      return notify(alert, 0);
    },

    async tick() {
      let moved = 0;
      for (const alert of await alerts.dueAlerts(clock.now())) {
        await notify(alert, alert.level + 1);
        moved += 1;
      }
      return moved;
    },

    async acknowledge(alertId, actor, by) {
      const alert = await alerts.getAlert(alertId);
      if (!alert) throw new AlertTransitionError(`No alert ${alertId}`);
      if (alert.status !== "open") throw new AlertTransitionError(`This alert is already ${alert.status}`);
      const now = clock.now().toISOString();
      const updated = await alerts.updateAlert(alertId, { status: "acknowledged", acknowledgedBy: actor, acknowledgedAt: now, escalateAfter: null });
      await event(updated, "alert_acknowledged", `${actor} took the urgent alert. Escalation stopped.`, actor);

      // Only now is it true that a named person has it, so only now tell the patient.
      const who = await describePatient(alert);
      const source = alert.messageId ? await store.getMessage(alert.messageId) : null;
      const channel = source?.channel ?? "imessage";
      await store.createMessage({
        surgeryId: alert.surgeryId,
        patientId: alert.patientId,
        direction: "out",
        channel,
        body: `Hi ${who.first}, ${by?.name ?? displayName(actor)} from your care team has your message and will contact you. If you feel very unwell, call ${clinic.phone}, or 911 in an emergency.`,
        deliveryStatus: channel === "imessage" ? "queued" : "sent",
      });
      return updated;
    },

    async resolve(alertId, actor, note) {
      const alert = await alerts.getAlert(alertId);
      if (!alert) throw new AlertTransitionError(`No alert ${alertId}`);
      if (alert.status === "resolved") throw new AlertTransitionError("This alert is already resolved");
      const now = clock.now().toISOString();
      const updated = await alerts.updateAlert(alertId, {
        status: "resolved",
        resolvedBy: actor,
        resolvedAt: now,
        resolution: note,
        escalateAfter: null,
        ...(alert.status === "open" ? { acknowledgedBy: actor, acknowledgedAt: now } : {}),
      });
      await event(updated, "alert_resolved", `${actor} resolved the urgent alert: ${note}`, actor, { note });
      return updated;
    },

    async handleStaffReply(phone, text) {
      const contact = await alerts.findContactByPhone(phone);
      if (!contact) return { handled: false, replies: [], surgeryId: null };
      const first = contact.name.split(" ")[0];
      const open = (await alerts.listAlerts({ activeOnly: true })).filter((a) => a.status === "open");
      // Prefer the alert this person was paged about, then the oldest one still open.
      const target = open.find((a) => a.notifiedContactId === contact.id) ?? open[open.length - 1];
      if (!target) return { handled: true, replies: [`Thanks ${first}. There are no open urgent alerts right now.`], surgeryId: null };
      if (!ACK.test(text)) {
        return { handled: true, replies: ["Reply ACK to take the open urgent alert, or open ReadyFor for details."], surgeryId: target.surgeryId };
      }
      await escalation.acknowledge(target.id, `${contact.role}:${contact.name}`, contact);
      const who = await describePatient(target);
      return {
        handled: true,
        replies: [`Thanks ${first}. You have ${who.name}'s alert; they've been told you'll be in touch. Mark it resolved in ReadyFor when done.`],
        surgeryId: target.surgeryId,
      };
    },

    async view(alert) {
      const [ladder, notifications, surgery, patient] = await Promise.all([
        alerts.listContacts(),
        alerts.listNotifications(alert.id),
        store.getSurgery(alert.surgeryId),
        store.getPatient(alert.patientId),
      ]);
      const byId = new Map(ladder.map((c) => [c.id, c]));
      const notified = alert.notifiedContactId ? byId.get(alert.notifiedContactId) : undefined;
      const next = alert.status === "open" && !alert.exhausted ? ladder[alert.level + 1] : undefined;
      return {
        ...alert,
        patientName: patient?.displayName ?? "",
        procedureName: surgery?.procedureName ?? "",
        scheduledAt: surgery?.scheduledAt ?? "",
        notified: notified ? { name: notified.name, role: notified.role } : null,
        next: next ? { name: next.name, role: next.role } : null,
        notifications: notifications.map((n) => {
          const c = byId.get(n.contactId);
          return { ...n, contactName: c?.name ?? "Former contact", contactRole: c?.role ?? "nurse" };
        }),
      };
    },
  };
  return escalation;
}
