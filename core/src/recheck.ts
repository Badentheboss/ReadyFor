/**
 * Scheduled recheck. Upcoming surgeries that were checked before are checked again once their
 * last check is older than `recheckAfterMs`, so new or changed findings surface days ahead.
 * Verified lab evidence that has aged out for the surgery date is sent back for re-review.
 *
 * Safe to run repeatedly: the record check never re-sends patient outreach, tasks are deduped
 * by title and requirement, and each stale-evidence finding is logged once.
 */
import type { Clock, Requirement, RunRecordCheck, Store, Surgery } from "./types.ts";

export interface RecheckSummary {
  checked: string[];
  findings: Array<{ surgeryId: string; key: string; kind: "new" | "changed" | "record_changed" | "evidence_stale" }>;
  errors: Array<{ surgeryId: string; message: string }>;
}

/** How old lab evidence may be, in days before surgery, per requirement key. Mirrors the record check rules. */
const EVIDENCE_WINDOW_DAYS: Record<string, number> = { preop_labs: 30, a1c_recent: 90 };
const DAY = 86_400_000;

export function createRechecker(deps: {
  store: Store;
  runRecordCheck: RunRecordCheck;
  clock: Clock;
  recheckAfterMs: number;
  horizonDays?: number;
}) {
  const { store, runRecordCheck, clock, recheckAfterMs } = deps;
  const horizonMs = (deps.horizonDays ?? 14) * DAY;

  async function taskOnce(surgery: Surgery, requirement: Requirement | null, title: string, detail: string, owner: Requirement["owner"]) {
    const open = (await store.listTasks(surgery.id)).filter((t) => t.status === "open");
    if (open.some((t) => t.title === title && t.requirementId === (requirement?.id ?? null))) return;
    await store.createTask({
      surgeryId: surgery.id,
      requirementId: requirement?.id ?? null,
      title,
      detail,
      owner: owner === "patient" ? "coordinator" : owner,
      origin: "agent",
    });
  }

  /** Lab evidence that no longer falls inside its window for this surgery date. */
  async function staleEvidence(surgery: Surgery, requirements: Requirement[], summary: RecheckSummary) {
    const events = await store.listEvents(surgery.id, 1000);
    for (const r of requirements) {
      const window = EVIDENCE_WINDOW_DAYS[r.key];
      const collected = r.evidence?.data?.collectedDate;
      if (!window || typeof collected !== "string" || !["verified", "evidence_received"].includes(r.status)) continue;
      const daysBefore = Math.floor((Date.parse(surgery.scheduledAt) - Date.parse(`${collected}T00:00:00Z`)) / DAY);
      if (daysBefore <= window) continue;
      const already = events.some(
        (e) => e.type === "evidence_stale" && e.data?.requirementId === r.id && e.data?.collectedDate === collected && e.data?.scheduledAt === surgery.scheduledAt,
      );
      if (already) continue;
      await store.addEvent({
        surgeryId: surgery.id,
        type: "evidence_stale",
        summary: `"${r.title}" relies on results from ${collected}, ${daysBefore} days before surgery; the rule allows ${window}. Staff should re-review it.`,
        actor: "system",
        data: { requirementId: r.id, key: r.key, collectedDate: collected, scheduledAt: surgery.scheduledAt },
      });
      await taskOnce(surgery, r, `Re-review: ${r.title}`, `Evidence collected ${collected} is ${daysBefore} days before surgery (limit ${window}).`, r.owner);
      summary.findings.push({ surgeryId: surgery.id, key: r.key, kind: "evidence_stale" });
    }
  }

  return {
    /** One pass. `force` rechecks every upcoming checked surgery regardless of when it was last checked. */
    async runOnce({ force = false } = {}): Promise<RecheckSummary> {
      const now = clock.now().getTime();
      const summary: RecheckSummary = { checked: [], findings: [], errors: [] };
      for (const surgery of await store.listSurgeries()) {
        const start = Date.parse(surgery.scheduledAt);
        if (start <= now || start - now > horizonMs) continue;
        // Never-checked surgeries are left for staff to start, so the first patient text is a deliberate act.
        if (!surgery.lastCheckedAt) continue;
        try {
          if (force || now - Date.parse(surgery.lastCheckedAt) >= recheckAfterMs) {
            const result = await runRecordCheck(surgery.id);
            summary.checked.push(surgery.id);
            const requirements = await store.listRequirements(surgery.id);
            const byKey = new Map(requirements.map((r) => [r.key, r]));
            const report = async (keys: string[], kind: "new" | "changed") => {
              for (const key of keys) {
                const r = byKey.get(key) ?? null;
                // Only findings that need someone: open blockers. A requirement that became satisfied needs nobody.
                if (!r || r.status !== "open") continue;
                await taskOnce(surgery, r, `Recheck: ${r.title}`, r.reason, r.owner);
                summary.findings.push({ surgeryId: surgery.id, key, kind });
              }
            };
            await report(result.created, "new");
            await report(result.changed, "changed");
            for (const key of result.needsReview ?? []) summary.findings.push({ surgeryId: surgery.id, key, kind: "record_changed" });
            const found = summary.findings.filter((f) => f.surgeryId === surgery.id);
            if (found.length) {
              await store.addEvent({
                surgeryId: surgery.id,
                type: "recheck_findings",
                summary: `Scheduled recheck found ${found.length} item${found.length === 1 ? "" : "s"} for staff: ${found.map((f) => f.key).join(", ")}.`,
                actor: "system",
                data: { findings: found },
              });
            }
          }
          await staleEvidence(surgery, await store.listRequirements(surgery.id), summary);
        } catch (err) {
          summary.errors.push({ surgeryId: surgery.id, message: err instanceof Error ? err.message : String(err) });
        }
      }
      return summary;
    },
  };
}

export type Rechecker = ReturnType<typeof createRechecker>;
