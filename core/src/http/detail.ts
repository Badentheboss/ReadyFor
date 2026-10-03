import type { Readiness, Requirement, Store, Surgery, SurgeryDetail, SurgerySummary, Task, Patient } from "../types.ts";
import { blockerSummaries, computeReadiness } from "../readiness.ts";
import { notFound } from "./errors.ts";

export async function requireSurgery(store: Store, id: string): Promise<Surgery> {
  const surgery = await store.getSurgery(id);
  if (!surgery) throw notFound("surgery", id);
  return surgery;
}

async function requirePatient(store: Store, id: string): Promise<Patient> {
  const patient = await store.getPatient(id);
  if (!patient) throw notFound("patient", id);
  return patient;
}

export async function buildSummary(store: Store, surgery: Surgery, now: Date): Promise<SurgerySummary> {
  const [patient, requirements] = await Promise.all([
    requirePatient(store, surgery.patientId),
    store.listRequirements(surgery.id),
  ]);
  return {
    surgery,
    patient,
    readiness: computeReadiness(surgery, requirements, now),
    blockers: blockerSummaries(requirements),
  };
}

export async function buildDetail(store: Store, surgery: Surgery, now: Date): Promise<SurgeryDetail> {
  const [patient, requirements, tasks, messages, documents, events] = await Promise.all([
    requirePatient(store, surgery.patientId),
    store.listRequirements(surgery.id),
    store.listTasks(surgery.id),
    store.listMessages(surgery.id),
    store.listDocuments(surgery.id),
    store.listEvents(surgery.id, 50),
  ]);
  return {
    surgery,
    patient,
    readiness: computeReadiness(surgery, requirements, now),
    requirements,
    tasks,
    messages,
    documents,
    events,
  };
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Thu Oct 8", in UTC like every other timestamp in the API. */
function shortDate(iso: string): string {
  const d = new Date(iso);
  return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

export function briefText(
  surgery: Surgery,
  patient: Patient,
  readiness: Readiness,
  requirements: Requirement[],
  tasks: Task[],
): string {
  const lines = [`${patient.displayName}, ${surgery.procedureName}, ${shortDate(surgery.scheduledAt)}. ${readiness.headline}.`];
  blockerSummaries(requirements).forEach((b, i) => {
    lines.push(`${i + 1}. ${b.title} (${b.owner}): ${b.reason}`);
  });
  const openTasks = tasks.filter((t) => t.status === "open");
  if (openTasks.length === 0) {
    lines.push("Open tasks: none.");
  } else {
    lines.push("Open tasks:");
    for (const t of openTasks) lines.push(`- ${t.title} (${t.owner})`);
  }
  return lines.join("\n");
}
