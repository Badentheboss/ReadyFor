/**
 * Schedule indicators from a synthetic FHIR R4 scheduling feed.
 *
 * Kept apart from readiness on purpose: readiness says whether the patient is prepared;
 * the schedule says whether the operating room, pre-op visit and anesthesia consult are
 * actually booked to match. Each finding cites the FHIR Appointment and its lastUpdated time.
 */
import type { Patient, Surgery } from "../types.ts";
import fixture from "./fixtures/schedule.json" with { type: "json" };

export type ScheduleItemKey = "or_case" | "preop_visit" | "anesthesia_consult";

/** The subset of a FHIR R4 Appointment the rules read. */
export interface FhirAppointment {
  resourceType: "Appointment";
  id: string;
  status: "proposed" | "pending" | "booked" | "arrived" | "fulfilled" | "cancelled" | "noshow";
  serviceType: Array<{ coding: Array<{ system: string; code: ScheduleItemKey }>; text: string }>;
  start: string;
  meta: { lastUpdated: string };
}

export interface ScheduleItem {
  key: ScheduleItemKey;
  title: string;
  status: "ok" | "attention" | "conflict";
  detail: string;
  source: { system: "fhir"; resource: string | null; lastUpdated: string | null };
}

export interface ScheduleStatus {
  level: "on_track" | "needs_attention" | "conflict" | "unknown";
  headline: string;
  checkedAt: string;
  feed: string;
  items: ScheduleItem[];
}

interface FixtureEntry {
  key: ScheduleItemKey;
  status: FhirAppointment["status"];
  /** Start relative to the surgery's scheduledAt, in minutes. */
  offsetMinutes: number;
  updatedHoursAgo: number;
}

const FEED = "Synthetic FHIR R4 Appointment feed";
const TITLES: Record<ScheduleItemKey, string> = {
  or_case: "Operating room booking",
  preop_visit: "Pre-op clinic visit",
  anesthesia_consult: "Anesthesia consult",
};
const CODE_SYSTEM = "https://readyfor.example/fhir/CodeSystem/surgical-schedule";
const ANESTHESIA_CONSULT_AGE = 65;
const PREOP_CUTOFF_HOURS = 24;
const OR_TOLERANCE_MINUTES = 15;

/** Builds the synthetic FHIR Appointments for a surgery. A real deployment would read these from the hospital's FHIR server. */
export function syntheticAppointments(surgery: Surgery, now: Date): FhirAppointment[] {
  const entries = (fixture as Record<string, FixtureEntry[]>)[surgery.id] ?? [];
  const surgeryStart = new Date(surgery.scheduledAt).getTime();
  return entries.map((e) => ({
    resourceType: "Appointment",
    id: `${surgery.id.replace(/^sur_/, "")}-${e.key.replace("_", "-")}`,
    status: e.status,
    serviceType: [{ coding: [{ system: CODE_SYSTEM, code: e.key }], text: TITLES[e.key] }],
    start: new Date(surgeryStart + e.offsetMinutes * 60_000).toISOString(),
    meta: { lastUpdated: new Date(now.getTime() - e.updatedHoursAgo * 3_600_000).toISOString() },
  }));
}

function ageOn(birthDate: string | null, at: Date): number | null {
  if (!birthDate) return null;
  const b = new Date(`${birthDate}T00:00:00Z`);
  let age = at.getUTCFullYear() - b.getUTCFullYear();
  if (at < new Date(Date.UTC(at.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate()))) age -= 1;
  return age;
}

const when = (iso: string) =>
  new Date(iso).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC", timeZoneName: "short" });

/** Applies the scheduling rules to a surgery's appointments. */
export function evaluateSchedule(surgery: Surgery, patient: Patient, appointments: FhirAppointment[], now: Date): ScheduleStatus {
  const checkedAt = now.toISOString();
  if (appointments.length === 0) {
    return { level: "unknown", headline: "No scheduling data", checkedAt, feed: FEED, items: [] };
  }
  const find = (key: ScheduleItemKey) =>
    appointments.find((a) => a.status !== "cancelled" && a.serviceType.some((s) => s.coding.some((c) => c.code === key)));
  const source = (a: FhirAppointment | undefined) => ({ system: "fhir" as const, resource: a ? `Appointment/${a.id}` : null, lastUpdated: a?.meta.lastUpdated ?? null });
  const surgeryStart = new Date(surgery.scheduledAt).getTime();
  const items: ScheduleItem[] = [];

  const or = find("or_case");
  if (!or) {
    items.push({ key: "or_case", title: TITLES.or_case, status: "conflict", detail: "No operating room booking found for this surgery.", source: source(or) });
  } else if (or.status !== "booked") {
    items.push({ key: "or_case", title: TITLES.or_case, status: "conflict", detail: `The OR booking is ${or.status}, not booked.`, source: source(or) });
  } else if (Math.abs(new Date(or.start).getTime() - surgeryStart) > OR_TOLERANCE_MINUTES * 60_000) {
    items.push({
      key: "or_case",
      title: TITLES.or_case,
      status: "conflict",
      detail: `The OR is booked for ${when(or.start)}, but the surgery is set for ${when(surgery.scheduledAt)}.`,
      source: source(or),
    });
  } else {
    items.push({ key: "or_case", title: TITLES.or_case, status: "ok", detail: `Booked for ${when(or.start)}.`, source: source(or) });
  }

  const preop = find("preop_visit");
  const cutoff = surgeryStart - PREOP_CUTOFF_HOURS * 3_600_000;
  if (!preop) {
    items.push({ key: "preop_visit", title: TITLES.preop_visit, status: "attention", detail: "No pre-op clinic visit is scheduled.", source: source(preop) });
  } else if (preop.status !== "booked" && preop.status !== "fulfilled" && preop.status !== "arrived") {
    items.push({ key: "preop_visit", title: TITLES.preop_visit, status: "attention", detail: `The visit on ${when(preop.start)} is ${preop.status}, not confirmed.`, source: source(preop) });
  } else if (new Date(preop.start).getTime() > cutoff) {
    items.push({ key: "preop_visit", title: TITLES.preop_visit, status: "attention", detail: `The visit on ${when(preop.start)} is less than ${PREOP_CUTOFF_HOURS} hours before surgery.`, source: source(preop) });
  } else {
    items.push({ key: "preop_visit", title: TITLES.preop_visit, status: "ok", detail: `${preop.status === "fulfilled" ? "Completed" : "Booked"} for ${when(preop.start)}.`, source: source(preop) });
  }

  const age = ageOn(patient.birthDate, new Date(surgery.scheduledAt));
  const required = age !== null && age >= ANESTHESIA_CONSULT_AGE;
  const consult = find("anesthesia_consult");
  if (consult && (consult.status === "booked" || consult.status === "fulfilled")) {
    items.push({ key: "anesthesia_consult", title: TITLES.anesthesia_consult, status: "ok", detail: `${consult.status === "fulfilled" ? "Completed" : "Booked"} for ${when(consult.start)}.`, source: source(consult) });
  } else if (required) {
    items.push({
      key: "anesthesia_consult",
      title: TITLES.anesthesia_consult,
      status: "attention",
      detail: consult ? `Required at age ${age}, but the consult is ${consult.status}.` : `Required at age ${age}, and none is scheduled.`,
      source: source(consult),
    });
  }

  const conflicts = items.filter((i) => i.status === "conflict").length;
  const attention = items.filter((i) => i.status === "attention").length;
  const level = conflicts ? "conflict" : attention ? "needs_attention" : "on_track";
  const headline = conflicts
    ? `Schedule conflict: ${items.find((i) => i.status === "conflict")!.title.toLowerCase()}`
    : attention
      ? `Schedule: ${attention} item${attention === 1 ? "" : "s"} to confirm`
      : "Schedule on track";
  return { level, headline, checkedAt, feed: FEED, items };
}

export function scheduleFor(surgery: Surgery, patient: Patient, now: Date): ScheduleStatus {
  return evaluateSchedule(surgery, patient, syntheticAppointments(surgery, now), now);
}
