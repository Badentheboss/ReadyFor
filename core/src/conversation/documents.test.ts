import { describe, expect, test } from "bun:test";
import type { LabExtraction } from "../types.ts";
import { assessLabDocument } from "./documents.ts";

const ctx = { patientName: "Harriet Lindqvist", surgeryDate: new Date("2026-10-08T12:30:00.000Z"), now: new Date("2026-10-03T20:00:00.000Z") };

const rows = (...names: string[]) => names.map((name) => ({ name, value: "1", unit: null, flag: null }));
const report = (over: Partial<LabExtraction> = {}): LabExtraction => ({
  isLabReport: true,
  patientName: "Harriet Lindqvist",
  collectedDate: "2026-09-29",
  facility: "Quillhaven Medical Group",
  results: rows("Hemoglobin", "Platelets", "Creatinine", "Potassium", "Sodium", "Glucose"),
  confidence: 0.9,
  notes: null,
  ...over,
});

describe("assessLabDocument", () => {
  test("the contract example passes all three checks", () => {
    const a = assessLabDocument(report(), ctx);
    expect(a.acceptable).toBe(true);
    expect(a.summary).toBe("Lab report from Quillhaven Medical Group, collected 2026-09-29, 6 results.");
    expect(a.checks).toEqual([
      { label: "Collected within 30 days of surgery", ok: true, detail: "9 days before surgery" },
      { label: "Patient name matches", ok: true, detail: "Harriet Lindqvist" },
      { label: "Required results present", ok: true, detail: "hemoglobin, platelets, creatinine, potassium" },
    ]);
  });

  test("a report older than 30 days fails the date check", () => {
    const a = assessLabDocument(report({ collectedDate: "2026-07-14" }), ctx);
    expect(a.acceptable).toBe(false);
    expect(a.checks[0]).toEqual({ label: "Collected within 30 days of surgery", ok: false, detail: "86 days before surgery" });
  });

  test("exactly 30 days is accepted, 31 is not", () => {
    expect(assessLabDocument(report({ collectedDate: "2026-09-08" }), ctx).checks[0]?.ok).toBe(true);
    expect(assessLabDocument(report({ collectedDate: "2026-09-07" }), ctx).checks[0]?.ok).toBe(false);
  });

  test("a missing date fails", () => {
    const a = assessLabDocument(report({ collectedDate: null }), ctx);
    expect(a.checks[0]).toEqual({ label: "Collected within 30 days of surgery", ok: false, detail: "No collection date found" });
    expect(a.summary).toContain("collection date not found");
  });

  test("a future date fails", () => {
    expect(assessLabDocument(report({ collectedDate: "2026-10-05" }), ctx).checks[0]?.ok).toBe(false);
  });

  test("today counts as collected", () => {
    expect(assessLabDocument(report({ collectedDate: "2026-10-03" }), ctx).checks[0]).toMatchObject({ ok: true, detail: "5 days before surgery" });
  });

  test.each(["LINDQVIST, HARRIET", "Harriet M. Lindqvist", "lindqvist harriet", "HARRIET LINDQVIST"])("name %p matches", (printed) => {
    expect(assessLabDocument(report({ patientName: printed }), ctx).checks[1]).toEqual({ label: "Patient name matches", ok: true, detail: printed });
  });

  test("another patient's name does not match", () => {
    expect(assessLabDocument(report({ patientName: "Morgan Rivera" }), ctx).checks[1]?.ok).toBe(false);
  });

  test("a missing name fails with the detail", () => {
    expect(assessLabDocument(report({ patientName: null }), ctx).checks[1]).toEqual({ label: "Patient name matches", ok: false, detail: "No name found" });
  });

  test("hemoglobin A1c does not count as hemoglobin", () => {
    const a = assessLabDocument(report({ results: rows("Hemoglobin A1c", "Platelet count", "Creatinine, serum", "Potassium") }), ctx);
    expect(a.checks[2]).toEqual({ label: "Required results present", ok: false, detail: "Found platelets, creatinine, potassium. Missing hemoglobin" });
  });

  test("accepts common spellings", () => {
    const a = assessLabDocument(report({ results: rows("HGB", "PLT", "CREATININE", "K") }), ctx);
    expect(a.checks[2]?.ok).toBe(true);
  });

  test("lists everything missing", () => {
    const a = assessLabDocument(report({ results: rows("Sodium") }), ctx);
    expect(a.checks[2]).toEqual({ label: "Required results present", ok: false, detail: "Missing hemoglobin, platelets, creatinine, potassium" });
    expect(a.summary).toBe("Lab report from Quillhaven Medical Group, collected 2026-09-29, 1 result.");
  });
});
