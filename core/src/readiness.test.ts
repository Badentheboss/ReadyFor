import { describe, expect, test } from "bun:test";
import { blockerSummaries, computeReadiness } from "./readiness.ts";
import type { Requirement, Surgery } from "./types.ts";

const NOW = new Date("2026-10-03T20:00:00.000Z");

function surgery(scheduledAt: string, lastCheckedAt: string | null = "2026-10-03T20:01:00.000Z"): Surgery {
  return {
    id: "sur_t",
    patientId: "pat_t",
    procedureCode: "TKA",
    procedureName: "Knee",
    scheduledAt,
    location: "OR",
    surgeon: "Dr. Demo",
    status: "scheduled",
    lastCheckedAt,
    createdAt: NOW.toISOString(),
  };
}

let n = 0;
function req(over: Partial<Requirement> = {}): Requirement {
  n += 1;
  return {
    id: `req_${n}`,
    surgeryId: "sur_t",
    key: `key_${n}`,
    title: `Title ${n}`,
    kind: "logistics",
    status: "open",
    blocking: true,
    owner: "coordinator",
    reason: `Reason ${n}`,
    source: null,
    proposal: null,
    evidence: null,
    verifiedBy: null,
    verifiedAt: null,
    staffNote: null,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...over,
  };
}

const inDays = (d: number, time = "20:00") => {
  const date = new Date(NOW);
  date.setUTCDate(date.getUTCDate() + d);
  return `${date.toISOString().slice(0, 10)}T${time}:00.000Z`;
};

describe("computeReadiness", () => {
  test("no requirements and never checked", () => {
    const r = computeReadiness(surgery(inDays(5), null), [], NOW);
    expect(r).toMatchObject({ level: "needs_attention", headline: "Not checked yet", blockers: 0, daysUntil: 5 });
  });

  test("checked with nothing blocking is ready", () => {
    expect(computeReadiness(surgery(inDays(5)), [], NOW).headline).toBe("Ready");
  });

  test("only cleared or non-blocking requirements is ready", () => {
    const reqs = [
      req({ status: "verified" }),
      req({ status: "waived" }),
      req({ status: "satisfied" }),
      req({ blocking: false, status: "open" }),
    ];
    expect(computeReadiness(surgery(inDays(1)), reqs, NOW)).toMatchObject({ level: "ready", blockers: 0, headline: "Ready" });
  });

  test("one blocker twelve days out needs attention, singular wording", () => {
    const r = computeReadiness(surgery(inDays(12)), [req()], NOW);
    expect(r).toEqual({
      level: "needs_attention",
      blockers: 1,
      openBlockers: 1,
      pendingVerification: 0,
      daysUntil: 12,
      headline: "Needs attention: 1 blocker, 12 days out",
    });
  });

  test("a health blocker is at risk however far away", () => {
    const r = computeReadiness(surgery(inDays(30)), [req({ kind: "health" })], NOW);
    expect(r.level).toBe("at_risk");
  });

  test("two days or fewer is at risk", () => {
    expect(computeReadiness(surgery(inDays(2)), [req()], NOW).level).toBe("at_risk");
    expect(computeReadiness(surgery(inDays(3)), [req()], NOW).level).toBe("needs_attention");
  });

  test("two open blockers within a week is at risk; at eight days it is not", () => {
    const reqs = [req(), req()];
    expect(computeReadiness(surgery(inDays(7)), reqs, NOW).level).toBe("at_risk");
    expect(computeReadiness(surgery(inDays(8)), reqs, NOW).level).toBe("needs_attention");
  });

  test("rule 5 counts open blockers, not evidence waiting for review", () => {
    const reqs = [req(), req({ status: "evidence_received" })];
    const r = computeReadiness(surgery(inDays(5)), reqs, NOW);
    expect(r).toMatchObject({ level: "needs_attention", blockers: 2, openBlockers: 1, pendingVerification: 1 });
  });

  test("headline for the demo shape", () => {
    const r = computeReadiness(surgery(inDays(5, "12:30")), [req(), req(), req()], NOW);
    expect(r.headline).toBe("At risk: 3 blockers, 5 days out");
  });

  test("daysUntil rounds up and never goes below zero", () => {
    expect(computeReadiness(surgery("2026-10-03T20:00:01.000Z"), [req()], NOW).daysUntil).toBe(1);
    expect(computeReadiness(surgery("2026-10-06T14:00:00.000Z"), [], NOW).daysUntil).toBe(3);
    const past = computeReadiness(surgery("2026-10-01T00:00:00.000Z"), [req()], NOW);
    expect(past).toMatchObject({ daysUntil: 0, level: "at_risk", headline: "At risk: 1 blocker, 0 days out" });
  });

  test("singular day", () => {
    expect(computeReadiness(surgery(inDays(1)), [req()], NOW).headline).toBe("At risk: 1 blocker, 1 day out");
  });
});

describe("blockerSummaries", () => {
  test("lists blocking open and evidence_received requirements only, in order", () => {
    const a = req({ status: "evidence_received", owner: "nurse" });
    const b = req({ status: "verified" });
    const c = req({ blocking: false });
    const d = req();
    expect(blockerSummaries([a, b, c, d])).toEqual([
      { id: a.id, key: a.key, title: a.title, status: "evidence_received", owner: "nurse", reason: a.reason },
      { id: d.id, key: d.key, title: d.title, status: "open", owner: "coordinator", reason: d.reason },
    ]);
  });
});
