import { describe, expect, test } from "bun:test";
import { buildProposal, formatSurgeryDate, labsOutreach, transportOutreach } from "./templates.ts";

const clinic = { name: "Northstar Surgical Center", phone: "(734) 555-0100" };

describe("buildProposal", () => {
  test("matches the contract example for apixaban", () => {
    const p = buildProposal("anticoagulant", { drugName: "Apixaban 5 MG Oral Tablet", patientFirstName: "Harriet", clinic });
    expect(p.templateKey).toBe("anticoagulant_pause");
    expect(p.drugClass).toBe("anticoagulant");
    expect(p.requiresStaffInstruction).toBe(true);
    expect(p.text).toBe(
      "Hi Harriet, a note from your surgical team about your blood thinner (apixaban). {{staff_instruction}} Please do not stop or change this medicine unless your care team has told you to. Questions? Call Northstar Surgical Center at (734) 555-0100.",
    );
  });

  test("template keys and plain wording per class", () => {
    const base = { patientFirstName: "Harriet", clinic };
    const a = buildProposal("antiplatelet", { ...base, drugName: "aspirin 81 MG Oral Tablet" });
    const d = buildProposal("diabetes", { ...base, drugName: "Metformin hydrochloride 500 MG Oral Tablet" });
    expect(a.templateKey).toBe("antiplatelet_plan");
    expect(a.text).toContain("your antiplatelet medicine (aspirin)");
    expect(d.templateKey).toBe("diabetes_day_of_surgery");
    expect(d.text).toContain("your diabetes medicine (metformin)");
    expect(a.requiresStaffInstruction && d.requiresStaffInstruction).toBe(true);
  });

  test("contains the placeholder exactly once and no dosing or timing words", () => {
    for (const tag of ["anticoagulant", "antiplatelet", "diabetes"] as const) {
      const { text } = buildProposal(tag, { drugName: "x 5 MG Oral Tablet", patientFirstName: "A", clinic });
      expect(text.split("{{staff_instruction}}").length).toBe(2);
      expect(text).not.toMatch(/\b(\d+\s*(mg|days?|hours?)|stop taking|hold|skip|take|morning|night|before surgery)\b/i);
    }
  });
});

describe("outreach", () => {
  const input = { patientFirstName: "Harriet", surgeryDate: "2026-10-08T12:30:00.000Z", clinic };
  test("date is shown in words", () => {
    expect(formatSurgeryDate("2026-10-08T12:30:00.000Z")).toBe("Thursday, October 8");
  });
  test("labs outreach", () => {
    const t = labsOutreach(input);
    expect(t).toContain("Harriet");
    expect(t).toContain("knee surgery on Thursday, October 8");
    expect(t).toContain("last 30 days");
    expect(t).toContain("photo");
  });
  test("transport outreach", () => {
    const t = transportOutreach(input);
    expect(t).toContain("who will be driving you home");
  });
});
