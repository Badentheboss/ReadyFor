import type {
  ClinicInfo,
  Clock,
  DrugClassification,
  DrugClassifier,
  DrugClassTag,
  HealthRecord,
  Message,
  Patient,
  RecordCheckResult,
  RecordMedication,
  RecordSource,
  Requirement,
  RequirementSource,
  RequirementStatus,
  RunRecordCheck,
  Store,
  Surgery,
  TemplateProposal,
} from "../types.ts";
import { daysBetween, latestLab, PREOP_LAB_ANALYTES } from "./labs.ts";
import { getProcedure } from "./procedures.ts";
import type { ProcedureRequirement } from "./procedures.ts";
import { plainIngredient, tagsForClassId } from "./rxclass.ts";
import { buildProposal, labsOutreach, transportOutreach } from "./templates.ts";

export interface RecordCheckDeps {
  store: Store;
  records: RecordSource;
  classifier: DrugClassifier;
  clock: Clock;
  clinic: ClinicInfo;
}

interface Desired {
  status: RequirementStatus;
  reason: string;
  source: RequirementSource;
  proposal: TemplateProposal | null;
}

interface ClassifiedMed {
  med: RecordMedication;
  classification: DrugClassification;
}

const PREOP_WINDOW_DAYS = 30;
const A1C_WINDOW_DAYS = 90;
// Rows in these statuses were decided by a person or a patient message. The check never touches them.
const PROTECTED: RequirementStatus[] = ["evidence_received", "verified", "waived"];

// Short names for the "check_ran" summary.
const SHORT_LABEL: Record<string, string> = {
  preop_labs: "pre-op blood work",
  a1c_recent: "recent A1c",
  anticoagulant_plan: "blood thinner plan",
  antiplatelet_plan: "aspirin and antiplatelet plan",
  diabetes_med_plan: "diabetes medication plan",
  transport: "ride home",
  fasting_ack: "fasting instructions",
};
const KIND_ORDER = ["medication", "lab", "logistics", "instruction", "health"];

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const capitalise = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
const joinNames = (names: string[]) =>
  names.length <= 2 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

export function createRecordCheck(deps: RecordCheckDeps): RunRecordCheck {
  const { store, records, classifier, clock, clinic } = deps;

  return async (surgeryId) => {
    const surgery = await store.getSurgery(surgeryId);
    if (!surgery) throw new Error("not_found");
    const patient = await store.getPatient(surgery.patientId);
    if (!patient) throw new Error("not_found");
    if (!patient.finchnodeSubject) {
      throw new Error(`Patient ${patient.id} has no FinchNode subject, so the record check cannot run.`);
    }
    const procedure = getProcedure(surgery.procedureCode);

    const record = await records.getRecord(patient.finchnodeSubject);
    const warnings: string[] = [];
    const classified = await classifyActiveMedications(record, classifier, warnings);
    if (classified.some((c) => c.classification.lookup === "local_fallback")) {
      warnings.push("RxClass was unreachable; drug classes came from the built-in table.");
    }

    const desired = new Map<string, Desired | null>();
    for (const req of procedure.requirements) {
      desired.set(req.key, evaluate(req.key, record, classified, surgery, patient, clinic));
    }

    // Save
    const created: string[] = [];
    const changed: string[] = [];
    const needsReview: string[] = [];
    const flagged: Requirement[] = [];
    for (const req of procedure.requirements) {
      const want = desired.get(req.key) ?? null;
      const row = await store.getRequirementByKey(surgery.id, req.key);

      if (!row) {
        if (!want) continue;
        const saved = await store.upsertRequirement({
          surgeryId: surgery.id,
          key: req.key,
          title: req.title,
          kind: req.kind,
          status: want.status,
          blocking: req.blocking,
          owner: req.owner,
          reason: want.reason,
          source: want.source,
          proposal: want.proposal,
          evidence: null,
        });
        created.push(req.key);
        if (saved.status === "open" && saved.blocking) flagged.push(saved);
        continue;
      }

      if (PROTECTED.includes(row.status)) {
        // Staff already decided. If the record behind the finding has changed since, ask them to
        // look again instead of overriding their decision. Updating the source makes this fire once.
        if (want && want.source.system !== "rule" && JSON.stringify(row.source) !== JSON.stringify(want.source)) {
          await store.updateRequirement(row.id, { source: want.source });
          needsReview.push(req.key);
          await store.addEvent({
            surgeryId: surgery.id,
            type: "requirement_needs_review",
            summary: `The health record changed after "${row.title}" was ${row.status.replace("_", " ")}: ${want.source.detail}`,
            actor: "system",
            data: { key: req.key, requirementId: row.id, status: row.status },
          });
          const open = (await store.listTasks(surgery.id)).filter((t) => t.status === "open");
          const title = `Re-review: ${row.title}`;
          if (!open.some((t) => t.title === title && t.requirementId === row.id)) {
            await store.createTask({
              surgeryId: surgery.id,
              requirementId: row.id,
              title,
              detail: `The record changed after this was ${row.status.replace("_", " ")}. ${want.source.detail}`,
              owner: row.owner === "patient" ? "coordinator" : row.owner,
              origin: "agent",
            });
          }
        }
        continue;
      }

      if (!want) {
        if (row.status === "open") {
          const reason = `No longer applies: ${noLongerApplies(req.key)}`;
          await store.updateRequirement(row.id, { status: "satisfied", reason });
          changed.push(req.key);
        }
        continue;
      }

      // Other modules adjust the reason on these rows (for example when the patient says they have no ride).
      if (want.source.system === "rule") continue;

      const differs =
        row.status !== want.status ||
        row.reason !== want.reason ||
        JSON.stringify(row.source) !== JSON.stringify(want.source) ||
        JSON.stringify(row.proposal) !== JSON.stringify(want.proposal);
      if (!differs) continue;
      const statusOrReasonChanged = row.status !== want.status || row.reason !== want.reason;
      await store.updateRequirement(row.id, {
        status: want.status,
        reason: want.reason,
        source: want.source,
        proposal: want.proposal,
      });
      if (statusOrReasonChanged) changed.push(req.key);
    }

    // Outreach: one question per run, and labs come first.
    const now = clock.now();
    const rows = await store.listRequirements(surgery.id);
    const byKey = new Map(rows.map((r) => [r.key, r]));
    const outbound: Message[] = [];
    const labsOpen = byKey.get("preop_labs")?.status === "open";
    const transportOpen = byKey.get("transport")?.status === "open";
    const priorEvents = await store.listEvents(surgery.id, 1000);
    const alreadyAsked = (key: string) => priorEvents.some((e) => e.type === "outreach_sent" && e.data?.key === key);

    let outreachKey: string | null = null;
    let body = "";
    const outreachInput = { patientFirstName: firstName(patient), surgeryDate: surgery.scheduledAt, clinic };
    if (labsOpen) {
      // While the labs question is outstanding the transport question waits.
      if (!alreadyAsked("preop_labs")) {
        outreachKey = "preop_labs";
        body = labsOutreach(outreachInput);
      }
    } else if (transportOpen && !alreadyAsked("transport")) {
      outreachKey = "transport";
      body = transportOutreach(outreachInput);
    }
    if (outreachKey) {
      const message = await store.createMessage({
        surgeryId: surgery.id,
        patientId: patient.id,
        direction: "out",
        channel: "imessage",
        body,
        deliveryStatus: "queued",
      });
      outbound.push(message);
      await store.addEvent({
        surgeryId: surgery.id,
        type: "outreach_sent",
        summary: outreachKey === "preop_labs" ? "Asked the patient about recent blood work." : "Asked the patient who will drive them home.",
        actor: "agent",
        data: { key: outreachKey, messageId: message.id },
      });
    }

    // Events and bookkeeping
    const blockers = rows
      .filter((r) => r.blocking && (r.status === "open" || r.status === "evidence_received"))
      .sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
    const names = blockers.map((r) => SHORT_LABEL[r.key] ?? r.title.toLowerCase());
    await store.addEvent({
      surgeryId: surgery.id,
      type: "check_ran",
      summary:
        blockers.length === 0
          ? "Record check: no blockers found."
          : `Record check: ${plural(blockers.length, "blocker")} found (${names.join(", ")}).`,
      actor: "agent",
      data: { created, changed, blockers: blockers.map((r) => r.key) },
    });
    for (const r of flagged) {
      await store.addEvent({
        surgeryId: surgery.id,
        type: "requirement_flagged",
        summary: `${r.title}: ${r.reason}`,
        actor: "agent",
        data: { key: r.key, requirementId: r.id },
      });
    }
    await store.updateSurgery(surgery.id, { lastCheckedAt: now.toISOString() });

    const result: RecordCheckResult = { surgeryId: surgery.id, created, changed, outbound, warnings, needsReview };
    return result;
  };
}

function firstName(patient: Patient): string {
  return patient.displayName.trim().split(/\s+/)[0] || "there";
}

async function classifyActiveMedications(
  record: HealthRecord,
  classifier: DrugClassifier,
  warnings: string[],
): Promise<ClassifiedMed[]> {
  const active = record.medications.filter((m) => m.status.toLowerCase() === "active");
  return Promise.all(
    active.map(async (med) => {
      try {
        return { med, classification: await classifier.classify({ name: med.name, rxcui: med.rxcui }) };
      } catch (err) {
        warnings.push(`Could not classify ${med.name}: ${err instanceof Error ? err.message : String(err)}`);
        const classification: DrugClassification = { tags: [], classes: [], lookup: "none", ingredient: null };
        return { med, classification };
      }
    }),
  );
}

function noLongerApplies(key: string): string {
  if (key === "a1c_recent") return "the record no longer lists diabetes.";
  if (key === "anticoagulant_plan") return "no active anticoagulant is in the record.";
  if (key === "antiplatelet_plan") return "no active antiplatelet is in the record.";
  if (key === "diabetes_med_plan") return "no active diabetes medication is in the record.";
  return "the requirement was not found in the current record.";
}

// ---------------------------------------------------------------------------
// Rules. Each returns the desired state, or null when the requirement does not apply.
// ---------------------------------------------------------------------------

function evaluate(
  key: string,
  record: HealthRecord,
  classified: ClassifiedMed[],
  surgery: Surgery,
  patient: Patient,
  clinic: ClinicInfo,
): Desired | null {
  switch (key) {
    case "preop_labs":
      return evaluatePreopLabs(record, surgery);
    case "a1c_recent":
      return evaluateA1c(record, surgery);
    case "anticoagulant_plan":
      return evaluateMedications("anticoagulant", classified, patient, clinic);
    case "antiplatelet_plan":
      return evaluateMedications("antiplatelet", classified, patient, clinic);
    case "diabetes_med_plan":
      return evaluateMedications("diabetes", classified, patient, clinic);
    case "transport":
      return {
        status: "open",
        reason: "The patient has not confirmed who will drive them home.",
        source: { system: "rule", detail: "Every knee replacement needs a confirmed ride home." },
        proposal: null,
      };
    case "fasting_ack":
      return {
        status: "open",
        reason: "Fasting instructions have not been sent yet.",
        source: { system: "rule", detail: "Every knee replacement needs fasting instructions acknowledged." },
        proposal: null,
      };
    default:
      return null;
  }
}

function evaluatePreopLabs(record: HealthRecord, surgery: Surgery): Desired {
  type Analyte = (typeof PREOP_LAB_ANALYTES)[number];
  type Found = { analyte: Analyte; date: string | null; days: number | null };
  type Dated = { analyte: Analyte; date: string; days: number };
  const found: Found[] = PREOP_LAB_ANALYTES.map((analyte) => {
    const lab = latestLab(record.labs, analyte, surgery.scheduledAt);
    const date = lab?.date ? lab.date.slice(0, 10) : null;
    const days = lab?.date ? daysBetween(lab.date, surgery.scheduledAt) : null;
    return { analyte, date, days };
  });
  const dated = found.filter((f): f is Dated => f.date !== null && f.days !== null);
  const recent = dated.filter((f) => f.days <= PREOP_WINDOW_DAYS);
  const missingRecent = found.filter((f) => !recent.some((r) => r.analyte === f.analyte)).map((f) => f.analyte);
  const data = { surgeryDate: surgery.scheduledAt.slice(0, 10), latest: Object.fromEntries(found.map((f) => [f.analyte, f.date])) };
  const listFound = dated.map((f) => `${f.analyte} ${f.date}`).join(", ");

  if (missingRecent.length === 0) {
    const oldest = Math.max(...recent.map((f) => f.days));
    const newestDate = recent.reduce((a, b) => (a.date > b.date ? a : b)).date;
    return {
      status: "satisfied",
      reason: `Blood work from ${newestDate} is on file, within ${PREOP_WINDOW_DAYS} days before surgery.`,
      source: {
        system: "finchnode",
        detail: `All required results are dated within ${PREOP_WINDOW_DAYS} days before surgery (oldest is ${plural(oldest, "day")} before): ${listFound}.`,
        data,
      },
      proposal: null,
    };
  }

  if (dated.length === 0) {
    return {
      status: "open",
      reason: "No blood work is on file.",
      source: {
        system: "finchnode",
        detail: `No ${PREOP_LAB_ANALYTES.join(", ")} results with a date were found in the record.`,
        data,
      },
      proposal: null,
    };
  }

  const detail = `Newest results in the record: ${listFound}. Nothing in the last ${PREOP_WINDOW_DAYS} days for: ${missingRecent.join(", ")}.`;
  if (recent.length === 0) {
    const newest = dated.reduce((a, b) => (a.date > b.date ? a : b));
    return {
      status: "open",
      reason: `The newest blood work is from ${newest.date}, ${plural(newest.days, "day")} before surgery.`,
      source: { system: "finchnode", detail, data },
      proposal: null,
    };
  }
  const newestRecent = recent.reduce((a, b) => (a.date > b.date ? a : b));
  return {
    status: "open",
    reason: `Blood work from ${newestRecent.date} is on file, but there is no recent ${joinNames(missingRecent)} result.`,
    source: { system: "finchnode", detail, data },
    proposal: null,
  };
}

function evaluateA1c(record: HealthRecord, surgery: Surgery): Desired | null {
  const hasDiabetes = record.conditions.some(
    (c) => /diabet/i.test(c.name) && !/pre-?diabet/i.test(c.name) && !["inactive", "resolved", "remission"].includes(c.status),
  );
  if (!hasDiabetes) return null;
  const lab = latestLab(record.labs, "a1c", surgery.scheduledAt);
  if (!lab || !lab.date) {
    return {
      status: "open",
      reason: "No A1c is on file.",
      source: { system: "finchnode", detail: "The record lists diabetes but has no dated A1c result." },
      proposal: null,
    };
  }
  const date = lab.date.slice(0, 10);
  const days = daysBetween(lab.date, surgery.scheduledAt);
  const result = `A1c ${lab.value}${lab.unit ? ` ${lab.unit}` : ""} on ${date}`;
  const data = { date, value: lab.value, unit: lab.unit };
  if (days <= A1C_WINDOW_DAYS) {
    return {
      status: "satisfied",
      reason: `An A1c from ${date} is on file, ${plural(days, "day")} before surgery.`,
      source: { system: "finchnode", detail: `${result}, ${plural(days, "day")} before surgery.`, data },
      proposal: null,
    };
  }
  return {
    status: "open",
    reason: `The newest A1c is from ${date}, ${plural(days, "day")} before surgery.`,
    source: { system: "finchnode", detail: `${result}, ${plural(days, "day")} before surgery (limit ${A1C_WINDOW_DAYS}).`, data },
    proposal: null,
  };
}

const TAG_WORDS: Record<DrugClassTag, { one: string; many: string; tail: string; manyTail: string }> = {
  anticoagulant: { one: "an anticoagulant", many: "anticoagulants", tail: "no pause plan is on file", manyTail: "no pause plan is on file" },
  antiplatelet: { one: "an antiplatelet", many: "antiplatelets", tail: "no plan for it is on file", manyTail: "no plan is on file" },
  diabetes: { one: "a diabetes medicine", many: "diabetes medicines", tail: "no plan for surgery day is on file", manyTail: "no plan for surgery day is on file" },
};

function evaluateMedications(tag: DrugClassTag, classified: ClassifiedMed[], patient: Patient, clinic: ClinicInfo): Desired | null {
  const meds = classified.filter((c) => c.classification.tags.includes(tag));
  if (meds.length === 0) return null;

  const rows = meds.map(({ med, classification }) => {
    const cls = classification.classes.find((c) => tagsForClassId(c.classId).includes(tag));
    const displayName = capitalise(med.name);
    const label = capitalise(classification.ingredient ?? plainIngredient(med.name) ?? med.name);
    const fallback = classification.lookup === "local_fallback";
    const detail = cls
      ? `${displayName} is ATC ${cls.classId} (${cls.className})${fallback ? " (built-in drug table; RxClass was unreachable)" : ""}`
      : `${displayName} is ${TAG_WORDS[tag].one}${fallback ? " (built-in drug table; RxClass was unreachable)" : ""}`;
    return {
      label,
      displayName,
      detail,
      data: { rxcui: med.rxcui, classId: cls?.classId ?? null, className: cls?.className ?? null, lookup: classification.lookup },
    };
  });

  const words = TAG_WORDS[tag];
  const first = rows[0]!;
  const reason =
    rows.length === 1
      ? `${first.label} is ${words.one} and ${words.tail}.`
      : `${joinNames(rows.map((r) => r.label))} are ${words.many} and ${words.manyTail}.`;
  const data: Record<string, unknown> = { ...first.data };
  if (rows.length > 1) data.medications = rows.map((r) => ({ name: r.displayName, ...r.data }));

  return {
    status: "open",
    reason,
    source: { system: "rxclass", detail: rows.map((r) => r.detail).join("; "), data },
    proposal: buildProposal(tag, { drugName: first.displayName, patientFirstName: firstName(patient), clinic }),
  };
}
