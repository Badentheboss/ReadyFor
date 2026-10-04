/**
 * Standby: synthetic waiting-list patients who could take a slot if a surgery at risk falls through.
 * ReadyFor only suggests and records offers; staff decide, and the original surgery is never changed here.
 * Offer state lives in the surgery's event history (standby_offered / standby_accepted / standby_declined).
 */
import { computeReadiness } from "./readiness.ts";
import type { EventRecord, SeedData, StandbyStatus, StandbyView, Store, Surgery } from "./types.ts";

const WINDOW_DAYS = 7;
const TYPES: Record<string, StandbyStatus> = { standby_offered: "offered", standby_accepted: "accepted", standby_declined: "declined" };

export async function standbyFor(store: Store, seed: SeedData, surgery: Surgery, now: Date): Promise<StandbyView> {
  const readiness = computeReadiness(surgery, await store.listRequirements(surgery.id), now);
  const hoursUntil = (Date.parse(surgery.scheduledAt) - now.getTime()) / 3_600_000;
  const atRisk = readiness.blockers > 0 && readiness.daysUntil <= WINDOW_DAYS && hoursUntil > 0;
  const reason = atRisk
    ? `${readiness.blockers} blocker${readiness.blockers === 1 ? "" : "s"} open, ${readiness.daysUntil} day${readiness.daysUntil === 1 ? "" : "s"} out: line up a backup in case this slot opens.`
    : readiness.blockers === 0
      ? "No open blockers; no backup needed."
      : `More than ${WINDOW_DAYS} days out; backups are suggested inside a week.`;

  const events = (await store.listEvents(surgery.id, 1000)).filter((e) => e.type in TYPES);
  const latest = new Map<string, EventRecord>();
  // Events come newest first; the first one seen per candidate is the current state.
  for (const e of events) {
    const id = String(e.data?.candidateId ?? "");
    if (id && !latest.has(id)) latest.set(id, e);
  }

  const candidates = (seed.standby ?? [])
    .filter((c) => c.procedureCode === surgery.procedureCode && c.surgeon === surgery.surgeon)
    .map((c) => {
      const e = latest.get(c.id);
      return {
        ...c,
        status: e ? TYPES[e.type]! : ("suggested" as StandbyStatus),
        updatedAt: e?.createdAt ?? null,
        by: e?.actor ?? null,
        canMakeIt: hoursUntil >= c.noticeHours,
      };
    })
    .sort((a, b) => Number(b.canMakeIt) - Number(a.canMakeIt) || b.waitingSinceDays - a.waitingSinceDays);

  const confirmed = candidates.find((c) => c.status === "accepted")?.id ?? null;
  return { eligible: atRisk || confirmed !== null || candidates.some((c) => c.status === "offered"), reason, candidates, confirmed };
}

export class StandbyError extends Error {}

/** offer: suggested/declined → offered. accept / decline: offered → accepted / declined. One acceptance per slot. */
export async function applyStandbyAction(
  store: Store,
  seed: SeedData,
  surgery: Surgery,
  now: Date,
  candidateId: string,
  action: "offer" | "accept" | "decline",
  actor: string,
): Promise<StandbyView> {
  const view = await standbyFor(store, seed, surgery, now);
  const candidate = view.candidates.find((c) => c.id === candidateId);
  if (!candidate) throw new StandbyError(`No standby candidate ${candidateId} for this surgery`);
  if (action === "offer") {
    if (candidate.status === "offered" || candidate.status === "accepted") throw new StandbyError(`${candidate.name} is already ${candidate.status}`);
    if (view.confirmed) throw new StandbyError("A backup has already accepted this slot");
  } else if (candidate.status !== "offered") {
    throw new StandbyError(`Offer the slot to ${candidate.name} first`);
  } else if (action === "accept" && view.confirmed) {
    throw new StandbyError("A backup has already accepted this slot");
  }
  const when = new Date(surgery.scheduledAt).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
  const summary = {
    offer: `${actor} offered ${candidate.name} the ${when} slot as a backup.`,
    accept: `${candidate.name} accepted the ${when} slot as a backup. The original surgery is unchanged.`,
    decline: `${candidate.name} declined the ${when} slot.`,
  }[action];
  await store.addEvent({
    surgeryId: surgery.id,
    type: `standby_${action === "offer" ? "offered" : action === "accept" ? "accepted" : "declined"}`,
    summary,
    actor,
    data: { candidateId },
  });
  return standbyFor(store, seed, surgery, now);
}
