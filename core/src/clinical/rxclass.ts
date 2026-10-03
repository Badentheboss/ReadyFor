import type { DrugClassification, DrugClassifier, DrugClassTag } from "../types.ts";

const DEFAULT_BASE_URL = "https://rxnav.nlm.nih.gov/REST";
const DOWN_FOR_MS = 60_000;

type Obj = Record<string, unknown>;
type ClassEntry = { classId: string; className: string };

export interface RxClassOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// ATC class to tag
// ---------------------------------------------------------------------------

const ANTICOAGULANT_PREFIXES = ["B01AA", "B01AB", "B01AE", "B01AF", "B01AX"];

export function tagsForClassId(classId: string): DrugClassTag[] {
  const id = classId.toUpperCase();
  if (ANTICOAGULANT_PREFIXES.some((p) => id.startsWith(p))) return ["anticoagulant"];
  if (id.startsWith("B01AC")) return ["antiplatelet"];
  if (id.startsWith("A10")) return ["diabetes"];
  return [];
}

function tagsForClasses(classes: ClassEntry[]): DrugClassTag[] {
  const tags: DrugClassTag[] = [];
  for (const c of classes) for (const t of tagsForClassId(c.classId)) if (!tags.includes(t)) tags.push(t);
  return tags;
}

// ---------------------------------------------------------------------------
// Ingredient names
// ---------------------------------------------------------------------------

const SALTS = [
  "hydrochloride", "hcl", "sodium", "potassium", "calcium", "succinate", "tartrate", "sulfate", "sulphate",
  "maleate", "mesylate", "besylate", "fumarate", "phosphate", "acetate", "citrate", "bromide", "nitrate",
  "hydrobromide", "carbonate", "chloride",
];

/**
 * Candidate ingredient names for a medication name, best first:
 * "24 HR metoprolol succinate 50 MG Extended Release Oral Tablet" -> ["metoprolol succinate", "metoprolol"].
 */
export function ingredientCandidates(medName: string): string[] {
  let s = medName.toLowerCase();
  s = s.replace(/\([^)]*\)|\[[^\]]*\]/g, " ");
  s = s.replace(/\b\d+\s*hr\b/g, " ");
  // Everything from the first strength or number onward is dose, form or schedule.
  const cut = s.search(/\b\d/);
  if (cut >= 0) s = s.slice(0, cut);
  s = s.replace(
    /\b(oral|tablets?|capsules?|extended|delayed|release|chewable|injectable|injection|solution|suspension|cream|ointment|patch|topical|inhaler|er|xr|sr|dr|pen|syringe|kit)\b/g,
    " ",
  );
  s = s.replace(/[^a-z/ -]/g, " ").replace(/\s+/g, " ").trim();
  if (!s) return [];

  const withoutSalt = s
    .split(" / ")
    .map((part) =>
      part
        .split(" ")
        .filter((w) => !SALTS.includes(w))
        .join(" ")
        .trim(),
    )
    .filter(Boolean)
    .join(" / ");

  const out = [s];
  if (withoutSalt && withoutSalt !== s) out.push(withoutSalt);
  return out;
}

/** The plain-words ingredient: salts stripped, e.g. "metformin" for "metformin hydrochloride 500 MG Oral Tablet". */
export function plainIngredient(medName: string): string | null {
  const c = ingredientCandidates(medName);
  return c[c.length - 1] ?? null;
}

// ---------------------------------------------------------------------------
// Built-in fallback table, used only when RxClass cannot be reached
// ---------------------------------------------------------------------------

const VKA: ClassEntry = { classId: "B01AA", className: "Vitamin K antagonists" };
const HEPARINS: ClassEntry = { classId: "B01AB", className: "Heparin group" };
const THROMBIN: ClassEntry = { classId: "B01AE", className: "Direct thrombin inhibitors" };
const XA: ClassEntry = { classId: "B01AF", className: "Direct factor Xa inhibitors" };
const PLATELET: ClassEntry = { classId: "B01AC", className: "Platelet aggregation inhibitors excl. heparin" };
const INSULINS: ClassEntry = { classId: "A10A", className: "Insulins and analogues" };
const BIGUANIDES: ClassEntry = { classId: "A10BA", className: "Biguanides" };
const SULFONYLUREAS: ClassEntry = { classId: "A10BB", className: "Sulfonylureas" };
const GLP1: ClassEntry = { classId: "A10BJ", className: "Glucagon-like peptide-1 (GLP-1) analogues" };
const DPP4: ClassEntry = { classId: "A10BH", className: "Dipeptidyl peptidase 4 (DPP-4) inhibitors" };
const SGLT2: ClassEntry = { classId: "A10BK", className: "Sodium-glucose co-transporter 2 (SGLT2) inhibitors" };

const FALLBACK: Record<string, ClassEntry> = {
  warfarin: VKA,
  apixaban: XA,
  rivaroxaban: XA,
  dabigatran: THROMBIN,
  edoxaban: XA,
  enoxaparin: HEPARINS,
  heparin: HEPARINS,
  aspirin: PLATELET,
  clopidogrel: PLATELET,
  prasugrel: PLATELET,
  ticagrelor: PLATELET,
  metformin: BIGUANIDES,
  insulin: INSULINS,
  glipizide: SULFONYLUREAS,
  glyburide: SULFONYLUREAS,
  glimepiride: SULFONYLUREAS,
  sitagliptin: DPP4,
  empagliflozin: SGLT2,
  dapagliflozin: SGLT2,
  semaglutide: GLP1,
  liraglutide: GLP1,
};

function fallbackClassify(name: string): DrugClassification {
  const words = (ingredientCandidates(name).join(" ") + " " + name.toLowerCase()).split(/[^a-z]+/);
  const classes: ClassEntry[] = [];
  let ingredient: string | null = null;
  for (const [drug, entry] of Object.entries(FALLBACK)) {
    if (!words.includes(drug)) continue;
    ingredient ??= drug;
    if (!classes.some((c) => c.classId === entry.classId)) classes.push(entry);
  }
  return {
    tags: tagsForClasses(classes),
    classes,
    lookup: "local_fallback",
    ingredient: ingredient ?? plainIngredient(name),
  };
}

// ---------------------------------------------------------------------------
// Live classifier
// ---------------------------------------------------------------------------

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Pulls ATC classes out of an RxClass response; ignores combination (MIN) entries when a plain ingredient exists. */
function parseResponse(body: unknown): { classes: ClassEntry[]; ingredient: string | null } {
  const list = isObj(body) && isObj(body.rxclassDrugInfoList) ? body.rxclassDrugInfoList.rxclassDrugInfo : null;
  const entries = Array.isArray(list) ? list.filter(isObj) : [];
  const tty = (e: Obj) => (isObj(e.minConcept) && typeof e.minConcept.tty === "string" ? e.minConcept.tty : "");
  const hasPlain = entries.some((e) => tty(e) === "IN");
  const kept = hasPlain ? entries.filter((e) => tty(e) !== "MIN") : entries;

  const classes: ClassEntry[] = [];
  let ingredient: string | null = null;
  for (const e of kept) {
    const item = isObj(e.rxclassMinConceptItem) ? e.rxclassMinConceptItem : null;
    if (!item || typeof item.classId !== "string") continue;
    if (!classes.some((c) => c.classId === item.classId)) {
      classes.push({ classId: item.classId, className: typeof item.className === "string" ? item.className : item.classId });
    }
    if (!ingredient && tty(e) === "IN" && isObj(e.minConcept) && typeof e.minConcept.name === "string") {
      ingredient = e.minConcept.name.toLowerCase();
    }
  }
  return { classes, ingredient };
}

export function createRxClassClassifier(opts: RxClassOptions = {}): DrugClassifier {
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 8000;
  const cache = new Map<string, DrugClassification>();
  // After a network failure skip the network for a minute, so one outage does not cost a timeout per medication.
  let downUntil = 0;

  async function get(path: string): Promise<unknown> {
    const res = await doFetch(`${baseUrl}${path}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`RxClass HTTP ${res.status}`);
    return res.json();
  }

  async function live(med: { name: string; rxcui: string | null }): Promise<DrugClassification> {
    const candidates = ingredientCandidates(med.name);
    let found: ReturnType<typeof parseResponse> = { classes: [], ingredient: null };

    if (med.rxcui) {
      found = parseResponse(await get(`/rxclass/class/byRxcui.json?rxcui=${encodeURIComponent(med.rxcui)}&relaSource=ATC`));
    }
    for (const candidate of candidates) {
      if (found.classes.length > 0) break;
      found = parseResponse(await get(`/rxclass/class/byDrugName.json?drugName=${encodeURIComponent(candidate)}&relaSource=ATC`));
    }

    if (found.classes.length === 0) {
      return { tags: [], classes: [], lookup: "none", ingredient: plainIngredient(med.name) };
    }
    return {
      tags: tagsForClasses(found.classes),
      classes: found.classes,
      lookup: "rxclass",
      ingredient: found.ingredient ?? plainIngredient(med.name),
    };
  }

  return {
    async classify(med) {
      const key = med.rxcui ? `rxcui:${med.rxcui}` : `name:${med.name.toLowerCase()}`;
      const cached = cache.get(key);
      if (cached) return cached;
      if (Date.now() < downUntil) return fallbackClassify(med.name);
      try {
        const result = await live(med);
        cache.set(key, result);
        return result;
      } catch {
        downUntil = Date.now() + DOWN_FOR_MS;
        return fallbackClassify(med.name);
      }
    },
  };
}
