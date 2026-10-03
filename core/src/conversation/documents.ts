import type { EvidenceCheck, LabExtraction } from "../types.ts";

export interface DocumentContext {
  patientName: string;
  surgeryDate: Date;
  now: Date;
}

export interface DocumentAssessment {
  /** Informational only. Staff always verify. */
  acceptable: boolean;
  summary: string;
  checks: EvidenceCheck[];
}

const DAY_MS = 86_400_000;
const MAX_DAYS_BEFORE_SURGERY = 30;

// Kept local on purpose: this module does not depend on core/src/clinical.
const REQUIRED: Array<{ label: string; matches: (name: string) => boolean }> = [
  { label: "hemoglobin", matches: (n) => /\b(hemoglobin|haemoglobin|hgb|hb)\b/.test(n) && !/(a1c|glycated|glycosylated|glycohemoglobin|hba)/.test(n) },
  { label: "platelets", matches: (n) => /\b(platelets?|plt)\b/.test(n) },
  { label: "creatinine", matches: (n) => /\bcreatinine\b/.test(n) && !/clearance/.test(n) },
  { label: "potassium", matches: (n) => /\bpotassium\b/.test(n) || n.trim() === "k" },
];

function cleanName(name: string): string {
  return name.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function nameTokens(name: string): string[] {
  return cleanName(name)
    .split(" ")
    .filter((t) => t.length > 1 && !["mr", "mrs", "ms", "dr", "jr", "sr", "mx"].includes(t));
}

/** "LINDQVIST, HARRIET M" matches "Harriet Lindqvist": first and last name present, any order, initials ignored. */
function namesMatch(expected: string, printed: string): boolean {
  const want = nameTokens(expected);
  const have = new Set(nameTokens(printed));
  const first = want[0];
  const last = want[want.length - 1];
  if (!first || !last) return false;
  return have.has(first) && have.has(last);
}

function utcDay(d: Date): number {
  return Math.floor(d.getTime() / DAY_MS);
}

function dateCheck(collectedDate: string | null, ctx: DocumentContext): EvidenceCheck {
  const label = "Collected within 30 days of surgery";
  if (!collectedDate) return { label, ok: false, detail: "No collection date found" };
  const collected = Date.parse(`${collectedDate}T00:00:00Z`);
  if (Number.isNaN(collected)) return { label, ok: false, detail: "No collection date found" };
  const collectedDay = utcDay(new Date(collected));
  if (collectedDay > utcDay(ctx.now)) return { label, ok: false, detail: `Collection date ${collectedDate} is in the future` };
  const before = utcDay(ctx.surgeryDate) - collectedDay;
  if (before < 0) return { label, ok: false, detail: `Collected ${-before} ${-before === 1 ? "day" : "days"} after surgery` };
  const detail = before === 0 ? "On the day of surgery" : `${before} ${before === 1 ? "day" : "days"} before surgery`;
  return { label, ok: before <= MAX_DAYS_BEFORE_SURGERY, detail };
}

function resultsCheck(extraction: LabExtraction): EvidenceCheck {
  const label = "Required results present";
  const found = REQUIRED.filter((req) => extraction.results.some((r) => req.matches(cleanName(r.name))));
  const missing = REQUIRED.filter((req) => !found.includes(req));
  const foundText = found.map((f) => f.label).join(", ");
  if (missing.length === 0) return { label, ok: true, detail: foundText };
  const missingText = `Missing ${missing.map((m) => m.label).join(", ")}`;
  return { label, ok: false, detail: found.length ? `Found ${foundText}. ${missingText}` : missingText };
}

export function assessLabDocument(extraction: LabExtraction, ctx: DocumentContext): DocumentAssessment {
  const nameOk = extraction.patientName ? namesMatch(ctx.patientName, extraction.patientName) : false;
  const checks: EvidenceCheck[] = [
    dateCheck(extraction.collectedDate, ctx),
    { label: "Patient name matches", ok: nameOk, detail: extraction.patientName ?? "No name found" },
    resultsCheck(extraction),
  ];
  const n = extraction.results.length;
  const parts = [
    extraction.facility ? `Lab report from ${extraction.facility}` : "Lab report",
    extraction.collectedDate ? `collected ${extraction.collectedDate}` : "collection date not found",
    `${n} ${n === 1 ? "result" : "results"}`,
  ];
  return {
    acceptable: checks.every((c) => c.ok),
    summary: `${parts.join(", ")}.`,
    checks,
  };
}
