import type { ClinicInfo, DrugClassTag, TemplateProposal } from "../types.ts";
import { plainIngredient } from "./rxclass.ts";

/**
 * Staff-approved wording. The agent only selects a template; it never writes medication advice.
 * Any instruction about stopping, timing or dosing is the literal {{staff_instruction}}, filled in by a staff member.
 */

interface TemplateDef {
  templateKey: string;
  /** Plain-words noun phrase for the medicine; the ingredient is added in brackets. */
  phrase: string;
}

const TEMPLATES: Record<DrugClassTag, TemplateDef> = {
  anticoagulant: { templateKey: "anticoagulant_pause", phrase: "your blood thinner" },
  antiplatelet: { templateKey: "antiplatelet_plan", phrase: "your antiplatelet medicine" },
  diabetes: { templateKey: "diabetes_day_of_surgery", phrase: "your diabetes medicine" },
};

export interface ProposalInput {
  drugName: string;
  patientFirstName: string;
  clinic: ClinicInfo;
}

export function buildProposal(tag: DrugClassTag, input: ProposalInput): TemplateProposal {
  const def = TEMPLATES[tag];
  const ingredient = plainIngredient(input.drugName);
  const medicine = ingredient ? `${def.phrase} (${ingredient})` : def.phrase;
  const text =
    `Hi ${input.patientFirstName}, a note from your surgical team about ${medicine}. ` +
    `{{staff_instruction}} ` +
    `Please do not stop or change this medicine unless your care team has told you to. ` +
    `Questions? Call ${input.clinic.name} at ${input.clinic.phone}.`;
  return {
    templateKey: def.templateKey,
    drugName: input.drugName,
    drugClass: tag,
    text,
    requiresStaffInstruction: true,
  };
}

// ---------------------------------------------------------------------------
// Patient outreach sent after a record check. Warm, short, no medical advice.
// ---------------------------------------------------------------------------

export interface OutreachInput {
  patientFirstName: string;
  /** The surgery's scheduledAt (ISO) or a Date. Shown as a UTC calendar date, e.g. "Thursday, October 8". */
  surgeryDate: string | Date;
  clinic: ClinicInfo;
}

export function formatSurgeryDate(value: string | Date): string {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "your surgery date";
  return d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
}

export function labsOutreach(input: OutreachInput): string {
  return (
    `Hi ${input.patientFirstName}, this is the ${input.clinic.name} team. We are getting you ready for your knee surgery on ${formatSurgeryDate(input.surgeryDate)}. ` +
    `We do not have any blood work from the last 30 days. Have you had blood tests done recently, at any clinic? ` +
    `If you have, you can text a photo of the results right here and we will pass it to your care team.`
  );
}

export function transportOutreach(input: OutreachInput): string {
  return (
    `Hi ${input.patientFirstName}, this is the ${input.clinic.name} team. One quick question about your knee surgery on ${formatSurgeryDate(input.surgeryDate)}: ` +
    `who will be driving you home afterwards? Just reply here with their name.`
  );
}
