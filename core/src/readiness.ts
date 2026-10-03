import type { BlockerSummary, Readiness, ReadinessLevel, Requirement, Surgery } from "./types.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

function isBlocker(r: Requirement): boolean {
  return r.blocking && (r.status === "open" || r.status === "evidence_received");
}

export function blockerSummaries(requirements: Requirement[]): BlockerSummary[] {
  return requirements.filter(isBlocker).map((r) => ({
    id: r.id,
    key: r.key,
    title: r.title,
    status: r.status,
    owner: r.owner,
    reason: r.reason,
  }));
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** Contract section 4. Computed on every read, never stored. */
export function computeReadiness(surgery: Surgery, requirements: Requirement[], now: Date): Readiness {
  const blockers = requirements.filter(isBlocker);
  const openBlockers = blockers.filter((r) => r.status === "open").length;
  const pendingVerification = blockers.filter((r) => r.status === "evidence_received").length;
  const daysUntil = Math.max(0, Math.ceil((new Date(surgery.scheduledAt).getTime() - now.getTime()) / DAY_MS));
  const counts = { blockers: blockers.length, openBlockers, pendingVerification, daysUntil };

  if (requirements.length === 0 && surgery.lastCheckedAt === null) {
    return { level: "needs_attention", ...counts, headline: "Not checked yet" };
  }
  if (blockers.length === 0) {
    return { level: "ready", ...counts, headline: "Ready" };
  }

  const atRisk =
    blockers.some((r) => r.kind === "health") || daysUntil <= 2 || (openBlockers >= 2 && daysUntil <= 7);
  const level: ReadinessLevel = atRisk ? "at_risk" : "needs_attention";
  const label = atRisk ? "At risk" : "Needs attention";
  return {
    level,
    ...counts,
    headline: `${label}: ${plural(blockers.length, "blocker")}, ${plural(daysUntil, "day")} out`,
  };
}
