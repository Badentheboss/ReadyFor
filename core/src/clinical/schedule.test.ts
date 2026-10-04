import { describe, expect, test } from "bun:test";
import type { Patient, Surgery } from "../types.ts";
import { applyScheduleChecks, evaluateSchedule, scheduleFor, syntheticAppointments, type FhirAppointment } from "./schedule.ts";

const NOW = new Date("2026-10-03T20:00:00.000Z");
const surgery = (id: string): Surgery => ({
  id, patientId: "pat_x", procedureCode: "TKA", procedureName: "Total knee replacement",
  scheduledAt: "2026-10-08T12:30:00.000Z", location: "OR 3", surgeon: "Dr. Avery Demo",
  status: "scheduled", lastCheckedAt: null, createdAt: NOW.toISOString(),
});
const patient = (birthDate: string | null): Patient => ({ id: "pat_x", finchnodeSubject: null, displayName: "Test Patient", phone: null, birthDate, createdAt: NOW.toISOString() });
const appt = (code: FhirAppointment["serviceType"][0]["coding"][0]["code"], status: FhirAppointment["status"], start: string): FhirAppointment => ({
  resourceType: "Appointment", id: `a-${code}`, status, start,
  serviceType: [{ coding: [{ system: "x", code }], text: code }], meta: { lastUpdated: "2026-10-03T10:00:00.000Z" },
});

describe("schedule indicators", () => {
  test("the demo surgeries cover on track, needs attention, and a conflict", () => {
    expect(scheduleFor(surgery("sur_morgan"), patient("1988-04-17"), NOW).level).toBe("on_track");
    const harriet = scheduleFor(surgery("sur_harriet"), patient("1948-03-02"), NOW);
    expect(harriet.level).toBe("needs_attention");
    expect(harriet.items.filter((i) => i.status === "attention").map((i) => i.key)).toEqual(["preop_visit", "anesthesia_consult"]);
    const jordan = scheduleFor(surgery("sur_jordan"), patient("1986-01-01"), NOW);
    expect(jordan.level).toBe("conflict");
    expect(jordan.headline).toBe("Schedule conflict: operating room booking");
  });

  test("every finding cites its FHIR resource and lastUpdated time", () => {
    const s = scheduleFor(surgery("sur_harriet"), patient("1948-03-02"), NOW);
    expect(s.items[0]!.source).toEqual({ system: "fhir", resource: "Appointment/harriet-or-case", lastUpdated: "2026-10-02T14:00:00.000Z" });
    expect(s.items.find((i) => i.key === "anesthesia_consult")!.source.resource).toBeNull();
    expect(syntheticAppointments(surgery("sur_harriet"), NOW)[0]!.resourceType).toBe("Appointment");
  });

  test("a pre-op visit inside 24 hours, a cancelled OR, and an unknown surgery", () => {
    const late = evaluateSchedule(surgery("s"), patient("1990-01-01"), [
      appt("or_case", "booked", "2026-10-08T12:30:00.000Z"),
      appt("preop_visit", "booked", "2026-10-08T08:00:00.000Z"),
    ], NOW);
    expect(late.items.find((i) => i.key === "preop_visit")!.status).toBe("attention");
    const cancelled = evaluateSchedule(surgery("s"), patient("1990-01-01"), [appt("or_case", "cancelled", "2026-10-08T12:30:00.000Z")], NOW);
    expect(cancelled.items[0]).toMatchObject({ key: "or_case", status: "conflict" });
    expect(scheduleFor(surgery("sur_unknown"), patient(null), NOW)).toMatchObject({ level: "unknown", items: [] });
  });
});

test("a staff check stops applying once the booking changes", () => {
  const original = scheduleFor(surgery("sur_jordan"), patient("1986-01-01"), NOW);
  const or = original.items.find((i) => i.key === "or_case")!;
  const check = { key: "or_case" as const, fingerprint: or.fingerprint!, by: "coordinator:Dana", at: NOW.toISOString(), note: "Confirmed." };
  expect(applyScheduleChecks(original, [check]).level).toBe("on_track");
  const moved = evaluateSchedule(surgery("sur_jordan"), patient("1986-01-01"), [
    appt("or_case", "booked", "2026-10-08T16:30:00.000Z"),
    appt("preop_visit", "booked", "2026-10-01T10:00:00.000Z"),
  ], NOW);
  expect(applyScheduleChecks(moved, [check]).level).toBe("conflict");
});
