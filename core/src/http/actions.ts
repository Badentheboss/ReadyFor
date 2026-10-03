import { computeReadiness } from "../readiness.ts";
import type {
  Message,
  Owner,
  Readiness,
  Requirement,
  RequirementAction,
  RequirementPatch,
  Store,
  Task,
  TaskAction,
  TaskOrigin,
} from "../types.ts";
import { badRequest, HttpError, invalidTransition, notFound } from "./errors.ts";
import { requireSurgery } from "./detail.ts";
import {
  optionalOneOf,
  optionalString,
  OWNERS,
  requireOneOf,
  requireString,
  type Body,
} from "./validate.ts";

export const REQUIREMENT_ACTIONS: readonly RequirementAction[] = [
  "verify",
  "approve_template",
  "waive",
  "reject_evidence",
  "reopen",
];
export const TASK_ACTIONS: readonly TaskAction[] = ["complete", "reassign", "reopen"];

const PLACEHOLDER = "{{staff_instruction}}";

type Status = Requirement["status"];

// Where each action may start (approve_template also needs a proposal) and whether it needs a note.
const REQUIREMENT_RULES: Record<RequirementAction, { from: Status[]; noteRequired: boolean }> = {
  verify: { from: ["open", "evidence_received"], noteRequired: false },
  approve_template: { from: ["open"], noteRequired: false },
  waive: { from: ["open", "evidence_received"], noteRequired: true },
  reject_evidence: { from: ["evidence_received"], noteRequired: true },
  reopen: { from: ["verified", "waived", "satisfied"], noteRequired: false },
};

export interface RequirementActionResult {
  requirement: Requirement;
  readiness: Readiness;
  outbound: Message[];
}

export async function applyRequirementAction(
  store: Store,
  now: Date,
  requirementId: string,
  body: Body,
  /** The authenticated actor. When set it replaces any `actor` in the body. */
  verifiedActor?: string | null,
): Promise<RequirementActionResult> {
  const action = requireOneOf(body, "action", REQUIREMENT_ACTIONS);
  const actor = verifiedActor ?? requireString(body, "actor");
  const note = optionalString(body, "note")?.trim() || null;

  const requirement = await store.getRequirement(requirementId);
  if (!requirement) throw notFound("requirement", requirementId);

  const rule = REQUIREMENT_RULES[action];
  const verb = action.replace("_", " ");
  if (!rule.from.includes(requirement.status)) {
    throw invalidTransition(`Cannot ${verb} a requirement that is ${requirement.status.replace("_", " ")}`);
  }
  if (action === "approve_template" && !requirement.proposal) {
    throw invalidTransition("Cannot approve a template: this requirement has no proposal");
  }
  const needsNote =
    rule.noteRequired || (action === "approve_template" && requirement.proposal?.requiresStaffInstruction === true);
  if (needsNote && !note) {
    throw new HttpError(400, "note_required", `A note is required to ${verb}`);
  }

  const surgery = await requireSurgery(store, requirement.surgeryId);
  const verifiedStamp = { verifiedBy: actor, verifiedAt: now.toISOString(), staffNote: note };
  const cleared = { verifiedBy: null, verifiedAt: null, staffNote: note };
  const outbound: Message[] = [];
  let patch: RequirementPatch;
  let eventType: string;
  let summary: string;

  switch (action) {
    case "verify":
      patch = { status: "verified", reason: `Verified by ${actor}.`, ...verifiedStamp };
      eventType = "requirement_verified";
      summary = `${actor} verified "${requirement.title}".`;
      break;
    case "approve_template": {
      const proposal = requirement.proposal!;
      const text = fillTemplate(proposal.text, note);
      outbound.push(
        await store.createMessage({
          surgeryId: surgery.id,
          patientId: surgery.patientId,
          direction: "out",
          channel: "imessage",
          body: text,
          deliveryStatus: "queued",
        }),
      );
      // Approval is the clinical decision, so it clears the requirement. Delivery is tracked
      // separately (SurgeryDetail.outreach) so a failed send stays visible.
      patch = {
        status: "verified",
        reason: `Plan approved by ${actor}. The message to the patient is tracked under outreach.`,
        ...verifiedStamp,
        outreachMessageId: outbound[0]!.id,
      };
      eventType = "template_approved";
      summary = `${actor} approved the ${proposal.drugName} message for "${requirement.title}" and queued it for the patient.`;
      break;
    }
    case "waive":
      patch = { status: "waived", reason: `Waived by ${actor}: ${note}`, ...verifiedStamp };
      eventType = "requirement_waived";
      summary = `${actor} waived "${requirement.title}": ${note}`;
      break;
    case "reject_evidence":
      patch = {
        status: "open",
        reason: `The evidence was rejected by ${actor}: ${note} A new upload is needed.`,
        ...cleared,
      };
      eventType = "evidence_rejected";
      summary = `${actor} rejected the evidence for "${requirement.title}": ${note}`;
      break;
    case "reopen":
      patch = { status: "open", reason: `Reopened by ${actor}.`, ...cleared, outreachMessageId: null };
      eventType = "requirement_reopened";
      summary = `${actor} reopened "${requirement.title}".`;
      break;
  }

  const documentId = requirement.evidence?.documentId;
  if (documentId && (action === "verify" || action === "reject_evidence")) {
    if (await store.getDocument(documentId)) {
      await store.updateDocument(documentId, { status: action === "verify" ? "verified" : "rejected" });
    }
  }

  const updated = await store.updateRequirement(requirement.id, patch);
  await store.addEvent({
    surgeryId: surgery.id,
    type: eventType,
    summary,
    actor,
    data: { requirementId: requirement.id, key: requirement.key, action, note, messageId: outbound[0]?.id ?? null },
  });

  const requirements = await store.listRequirements(surgery.id);
  return { requirement: updated, readiness: computeReadiness(surgery, requirements, now), outbound };
}

/** Replaces the placeholder with the staff sentence (split/join, so "$" in the note stays literal). */
function fillTemplate(text: string, note: string | null): string {
  if (note) return text.split(PLACEHOLDER).join(note);
  return text.split(PLACEHOLDER).join("").replace(/ {2,}/g, " ").trim();
}

export async function createTaskFromBody(store: Store, body: Body, verifiedActor?: string | null): Promise<Task> {
  const surgeryId = requireString(body, "surgeryId");
  const title = requireString(body, "title").trim();
  const owner = requireOneOf(body, "owner", OWNERS);
  const detail = optionalString(body, "detail");
  const requirementId = optionalString(body, "requirementId");
  const origin: TaskOrigin = optionalOneOf(body, "origin", ["staff", "agent"] as const) ?? "staff";
  const actor = verifiedActor ?? (optionalString(body, "actor")?.trim() || origin);

  const surgery = await requireSurgery(store, surgeryId);
  if (requirementId) {
    const requirement = await store.getRequirement(requirementId);
    if (!requirement) throw notFound("requirement", requirementId);
    if (requirement.surgeryId !== surgery.id) throw badRequest("requirementId belongs to a different surgery");
  }

  const task = await store.createTask({ surgeryId, requirementId: requirementId ?? null, title, detail, owner, origin });
  await store.addEvent({
    surgeryId,
    type: "task_created",
    summary: `${actor} created a task for the ${owner}: "${title}".`,
    actor,
    data: { taskId: task.id, owner, origin, requirementId: requirementId ?? null },
  });
  return task;
}

export async function applyTaskAction(
  store: Store,
  now: Date,
  taskId: string,
  body: Body,
  verifiedActor?: string | null,
): Promise<Task> {
  const action = requireOneOf(body, "action", TASK_ACTIONS);
  const actor = verifiedActor ?? requireString(body, "actor");
  const owner: Owner | undefined = action === "reassign" ? requireOneOf(body, "owner", OWNERS) : undefined;

  const task = await store.getTask(taskId);
  if (!task) throw notFound("task", taskId);

  let updated: Task;
  let eventType: string;
  let summary: string;
  switch (action) {
    case "complete":
      if (task.status !== "open") throw invalidTransition("Cannot complete a task that is already done");
      updated = await store.updateTask(task.id, { status: "done", completedAt: now.toISOString(), completedBy: actor });
      eventType = "task_completed";
      summary = `${actor} completed the task "${task.title}".`;
      break;
    case "reassign":
      if (task.status !== "open") throw invalidTransition("Cannot reassign a task that is done");
      updated = await store.updateTask(task.id, { owner });
      eventType = "task_reassigned";
      summary = `${actor} reassigned the task "${task.title}" from the ${task.owner} to the ${owner}.`;
      break;
    case "reopen":
      if (task.status !== "done") throw invalidTransition("Cannot reopen a task that is still open");
      updated = await store.updateTask(task.id, { status: "open", completedAt: null, completedBy: null });
      eventType = "task_reopened";
      summary = `${actor} reopened the task "${task.title}".`;
      break;
  }

  await store.addEvent({
    surgeryId: task.surgeryId,
    type: eventType,
    summary,
    actor,
    data: { taskId: task.id, action, owner: updated.owner },
  });
  return updated;
}
