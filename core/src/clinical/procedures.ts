import type { Owner, RequirementKind } from "../types.ts";

export interface ProcedureRequirement {
  key: string;
  title: string;
  kind: RequirementKind;
  blocking: boolean;
  owner: Owner;
}

export interface Procedure {
  code: string;
  requirements: ProcedureRequirement[];
}

// `health_review` is created by the conversation module when a patient reports a symptom, not here.
const TKA: Procedure = {
  code: "TKA",
  requirements: [
    { key: "preop_labs", title: "Pre-op blood work within 30 days", kind: "lab", blocking: true, owner: "nurse" },
    { key: "a1c_recent", title: "A1c within 90 days", kind: "lab", blocking: false, owner: "nurse" },
    { key: "anticoagulant_plan", title: "Blood thinner plan", kind: "medication", blocking: true, owner: "surgeon" },
    { key: "antiplatelet_plan", title: "Aspirin and antiplatelet plan", kind: "medication", blocking: false, owner: "nurse" },
    { key: "diabetes_med_plan", title: "Diabetes medication plan", kind: "medication", blocking: false, owner: "nurse" },
    { key: "transport", title: "Ride home confirmed", kind: "logistics", blocking: true, owner: "coordinator" },
    { key: "fasting_ack", title: "Fasting instructions understood", kind: "instruction", blocking: false, owner: "patient" },
  ],
};

const PROCEDURES: Record<string, Procedure> = { TKA };

export function getProcedure(code: string): Procedure {
  const procedure = Object.hasOwn(PROCEDURES, code) ? PROCEDURES[code] : undefined;
  if (!procedure) {
    throw new Error(`Unknown procedure code "${code}". Known codes: ${Object.keys(PROCEDURES).join(", ")}`);
  }
  return procedure;
}
