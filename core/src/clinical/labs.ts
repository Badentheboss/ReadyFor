import type { RecordLab } from "../types.ts";

export type AnalyteKey = "hemoglobin" | "platelets" | "creatinine" | "potassium" | "a1c";

/** The analytes the `preop_labs` requirement needs, all within 30 days before surgery. */
export const PREOP_LAB_ANALYTES = ["hemoglobin", "platelets", "creatinine", "potassium"] as const satisfies readonly AnalyteKey[];

// Names that contain an analyte word but are a different test. FinchNode uses LOINC long names, so
// "Glomerular filtration rate ... Creatinine-based formula" must not count as creatinine.
const NOT_THESE = /urine|stool|glomerular|\bgfr\b|egfr|clearance|ratio|corpuscular|mean cell|panel/;

/**
 * Maps a lab name from a health record or a document to one of the analytes we care about.
 * Works on short names ("Hgb") and LOINC long names ("Hemoglobin [Mass/volume] in Blood").
 */
export function matchAnalyte(name: string): AnalyteKey | null {
  const n = name.toLowerCase();
  // A1c first, so "Hemoglobin A1c/Hemoglobin.total in Blood" is never read as hemoglobin.
  if (/a1c|glycated|glycosylated|glycohemoglobin/.test(n)) return "a1c";
  if (NOT_THESE.test(n)) return null;
  const tokens = n.split(/[^a-z0-9]+/).filter(Boolean);
  const has = (...words: string[]) => words.some((w) => tokens.includes(w));
  if (has("hemoglobin", "haemoglobin", "hgb", "hb")) return "hemoglobin";
  if (has("platelet", "platelets", "plt")) return "platelets";
  if (has("creatinine")) return "creatinine";
  if (has("potassium") || tokens[0] === "k") return "potassium";
  return null;
}

function parseDate(value: Date | string): Date | null {
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Whole calendar days (UTC) from `from` to `to`. Negative when `to` is earlier. NaN if either date is invalid. */
export function daysBetween(from: Date | string, to: Date | string): number {
  const a = parseDate(from);
  const b = parseDate(to);
  if (!a || !b) return Number.NaN;
  const dayMs = 86_400_000;
  const dayA = Math.floor(a.getTime() / dayMs);
  const dayB = Math.floor(b.getTime() / dayMs);
  return dayB - dayA;
}

/**
 * The newest dated result for an analyte. Results without a value or a usable date are skipped.
 * With `onOrBefore`, results dated after that calendar day are skipped too.
 */
export function latestLab(labs: RecordLab[], analyte: AnalyteKey, onOrBefore?: Date | string): RecordLab | null {
  let best: RecordLab | null = null;
  let bestTime = -Infinity;
  for (const lab of labs) {
    if (matchAnalyte(lab.name) !== analyte) continue;
    if (lab.value === null || lab.value.trim() === "") continue;
    if (lab.date === null) continue;
    const d = parseDate(lab.date);
    if (!d) continue;
    if (onOrBefore !== undefined && !(daysBetween(d, onOrBefore) >= 0)) continue;
    if (d.getTime() > bestTime) {
      best = lab;
      bestTime = d.getTime();
    }
  }
  return best;
}
