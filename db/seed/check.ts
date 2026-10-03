import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

type Fixture = {
  notice?: unknown;
  surgeries?: unknown;
  requirementTemplates?: unknown;
  medicationTemplates?: unknown;
};

const fixturePath = resolve(import.meta.dir, "fixtures.json");
const errors: string[] = [];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkUniqueIds(items: unknown[], label: string) {
  const seen = new Set<string>();
  for (const [index, item] of items.entries()) {
    if (!isRecord(item) || typeof item.id !== "string" || item.id.length === 0) {
      errors.push(`${label}[${index}] must have a non-empty string id`);
      continue;
    }
    if (seen.has(item.id)) errors.push(`${label} has duplicate id "${item.id}"`);
    seen.add(item.id);
  }
}

const raw = await readFile(fixturePath, "utf8");
let fixture: Fixture;
try {
  fixture = JSON.parse(raw) as Fixture;
} catch (error) {
  console.error(`Invalid JSON in ${fixturePath}: ${String(error)}`);
  process.exit(1);
}

if (!isRecord(fixture)) errors.push("fixture root must be an object");
const surgeries = Array.isArray(fixture.surgeries) ? fixture.surgeries : [];
const requirements = Array.isArray(fixture.requirementTemplates) ? fixture.requirementTemplates : [];
const medications = Array.isArray(fixture.medicationTemplates) ? fixture.medicationTemplates : [];
if (!Array.isArray(fixture.surgeries)) errors.push("surgeries must be an array");
if (!Array.isArray(fixture.requirementTemplates)) errors.push("requirementTemplates must be an array");
if (!Array.isArray(fixture.medicationTemplates)) errors.push("medicationTemplates must be an array");

checkUniqueIds(surgeries, "surgeries");
checkUniqueIds(requirements, "requirementTemplates");
checkUniqueIds(medications, "medicationTemplates");

for (const [index, surgery] of surgeries.entries()) {
  if (!isRecord(surgery)) {
    errors.push(`surgeries[${index}] must be an object`);
    continue;
  }
  if (!isRecord(surgery.patient) || typeof surgery.patient.name !== "string") {
    errors.push(`surgeries[${index}].patient.name must be a string`);
  }
  if (typeof surgery.surgeryDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(surgery.surgeryDate)) {
    errors.push(`surgeries[${index}].surgeryDate must use YYYY-MM-DD`);
  }
  if (!Array.isArray(surgery.blockers) || !Array.isArray(surgery.tasks)) {
    errors.push(`surgeries[${index}] must have blockers and tasks arrays`);
  }
}

for (const [index, template] of medications.entries()) {
  if (!isRecord(template)) continue;
  if (template.status !== "staff-approved" && template.status !== "staff-approved-required") {
    errors.push(`medicationTemplates[${index}].status must indicate staff approval`);
  }
  if (typeof template.wording === "string" && template.wording.trim() && !template.wording.includes("Insert coordinator-approved wording")) {
    errors.push(`medicationTemplates[${index}].wording must remain a placeholder until staff-approved wording is supplied`);
  }
}

if (errors.length) {
  console.error("Seed fixture check failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Fixture check passed: ${surgeries.length} surgeries, ${requirements.length} requirement templates, ${medications.length} medication templates.`);
console.log("No database was changed. The core-owned demo seed is db/seed/demo.json and is loaded only by the documented /demo/reset route.");
