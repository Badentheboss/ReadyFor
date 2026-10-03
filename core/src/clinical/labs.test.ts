import { describe, expect, test } from "bun:test";
import type { RecordLab } from "../types.ts";
import { daysBetween, latestLab, matchAnalyte, PREOP_LAB_ANALYTES } from "./labs.ts";

describe("matchAnalyte", () => {
  test("short names and synonyms", () => {
    expect(matchAnalyte("Hgb")).toBe("hemoglobin");
    expect(matchAnalyte("Haemoglobin")).toBe("hemoglobin");
    expect(matchAnalyte("Platelet count")).toBe("platelets");
    expect(matchAnalyte("PLT")).toBe("platelets");
    expect(matchAnalyte("Creatinine, serum")).toBe("creatinine");
    expect(matchAnalyte("K")).toBe("potassium");
    expect(matchAnalyte("Potassium")).toBe("potassium");
    expect(matchAnalyte("HbA1c")).toBe("a1c");
    expect(matchAnalyte("Glycated hemoglobin")).toBe("a1c");
  });

  test("hemoglobin A1c is not hemoglobin", () => {
    expect(matchAnalyte("Hemoglobin A1c")).toBe("a1c");
    expect(matchAnalyte("Hemoglobin A1c/Hemoglobin.total in Blood")).toBe("a1c");
    expect(matchAnalyte("Hemoglobin [Mass/volume] in Blood")).toBe("hemoglobin");
  });

  test("LOINC long names from FinchNode", () => {
    expect(matchAnalyte("Creatinine [Mass/volume] in Serum or Plasma")).toBe("creatinine");
    expect(matchAnalyte("Potassium [Moles/volume] in Serum or Plasma")).toBe("potassium");
    expect(matchAnalyte("Platelets [#/volume] in Blood")).toBe("platelets");
  });

  test("lookalikes are rejected", () => {
    expect(
      matchAnalyte("Glomerular filtration rate [Volume Rate/Area] in Serum, Plasma or Blood by Creatinine-based formula (CKD-EPI 2021)/1.73 sq M"),
    ).toBeNull();
    expect(matchAnalyte("Creatinine [Mass/volume] in Urine")).toBeNull();
    expect(matchAnalyte("Sodium [Moles/volume] in Serum or Plasma")).toBeNull();
    expect(matchAnalyte("Leukocytes [#/volume] in Blood")).toBeNull();
    expect(matchAnalyte("Mean corpuscular hemoglobin")).toBeNull();
    expect(matchAnalyte("")).toBeNull();
  });

  test("preop analytes", () => {
    expect([...PREOP_LAB_ANALYTES]).toEqual(["hemoglobin", "platelets", "creatinine", "potassium"]);
  });
});

describe("latestLab", () => {
  const lab = (name: string, date: string | null, value: string | null = "1"): RecordLab => ({ name, value, unit: null, date });
  const labs = [
    lab("Creatinine", "2026-01-20T08:30:00Z", "1.6"),
    lab("Creatinine [Mass/volume] in Serum or Plasma", "2026-07-14T15:30:00Z", "1.7"),
    lab("Creatinine", "2026-09-01T00:00:00Z", null),
    lab("Creatinine", null, "9"),
    lab("Creatinine", "not a date", "9"),
    lab("Creatinine", "2026-12-01T00:00:00Z", "9"),
  ];

  test("newest dated result with a value", () => {
    expect(latestLab(labs, "creatinine")?.value).toBe("9"); // the one dated December
  });

  test("ignores results after the bound", () => {
    expect(latestLab(labs, "creatinine", "2026-10-08T12:30:00Z")?.value).toBe("1.7");
  });

  test("a result on the surgery day counts", () => {
    const l = [lab("Hgb", "2026-10-08T06:00:00Z", "12")];
    expect(latestLab(l, "hemoglobin", "2026-10-08T12:30:00Z")?.value).toBe("12");
  });

  test("null when nothing matches", () => {
    expect(latestLab(labs, "platelets")).toBeNull();
  });
});

describe("daysBetween", () => {
  test("86 days from 2026-07-14 to 2026-10-08", () => {
    expect(daysBetween("2026-07-14T15:30:00Z", "2026-10-08T12:30:00Z")).toBe(86);
  });
  test("uses calendar days, not elapsed hours", () => {
    expect(daysBetween("2026-10-07T23:00:00Z", "2026-10-08T01:00:00Z")).toBe(1);
  });
  test("negative and invalid", () => {
    expect(daysBetween("2026-10-09", "2026-10-08")).toBe(-1);
    expect(daysBetween("nope", "2026-10-08")).toBeNaN();
  });
});
