import type {
  Classification,
  Clock,
  ClinicInfo,
  ConversationContext,
  Effect,
  Evidence,
  HandleInbound,
  InboundInput,
  InboundResult,
  Llm,
  Message,
  Owner,
  Patient,
  Requirement,
  Store,
  Surgery,
  TaskOrigin,
} from "../types.ts";
import { UnknownSenderError } from "../types.ts";
import { assessLabDocument } from "./documents.ts";
import * as replies from "./replies.ts";

const ACTIVE = new Set(["open", "evidence_received"]);
const MIN_CONFIDENCE = 0.5;

export function createInboundHandler(deps: {
  store: Store;
  llm: Llm;
  clock: Clock;
  clinic: ClinicInfo;
  /** Raises an urgent alert for a reported symptom. Absent in tests that do not exercise escalation. */
  onUrgent?: (input: { surgeryId: string; summary: string; messageId: string }) => Promise<unknown>;
}): HandleInbound {
  const { store, llm, clock, clinic } = deps;

  async function resolveSurgery(input: InboundInput, now: Date): Promise<{ surgery: Surgery; patient: Patient }> {
    let surgery: Surgery | null = null;
    if (input.surgeryId) {
      surgery = await store.getSurgery(input.surgeryId);
    } else if (input.phone) {
      const found = await store.findPatientByPhone(input.phone);
      if (found) surgery = await store.nextSurgeryForPatient(found.id, now);
    }
    if (!surgery) throw new UnknownSenderError();
    const patient = await store.getPatient(surgery.patientId);
    if (!patient) throw new UnknownSenderError();
    return { surgery, patient };
  }

  return async function handleInbound(input) {
    const now = clock.now();
    const { surgery, patient } = await resolveSurgery(input, now);
    const first = patient.displayName.trim().split(/\s+/)[0] ?? "there";
    const body = input.body ?? "";
    const text = body.trim();
    const attachments = input.attachments ?? [];

    const effects: Effect[] = [];
    const outgoing: string[] = [];

    const inbound = await store.createMessage({
      surgeryId: surgery.id,
      patientId: patient.id,
      direction: "in",
      channel: input.channel,
      body,
      attachments: attachments.map((a) => ({ mimeType: a.mimeType, documentId: null })),
      deliveryStatus: "received",
    });
    await store.addEvent({
      surgeryId: surgery.id,
      type: "message_in",
      summary: text ? `Patient wrote: "${clip(text, 80)}"` : `Patient sent ${attachments.length} attachment${attachments.length === 1 ? "" : "s"}`,
      actor: "patient",
      data: { messageId: inbound.id, channel: input.channel },
    });

    async function createTaskUnlessDuplicate(spec: {
      title: string;
      owner: Owner;
      detail: string;
      requirementId?: string | null;
      origin: TaskOrigin;
      matchDetail?: boolean;
    }): Promise<boolean> {
      const open = (await store.listTasks(surgery.id)).filter((t) => t.status === "open");
      if (open.some((t) => t.title === spec.title && (!spec.matchDetail || t.detail === spec.detail))) return false;
      const task = await store.createTask({
        surgeryId: surgery.id,
        requirementId: spec.requirementId ?? null,
        title: spec.title,
        detail: spec.detail,
        owner: spec.owner,
        origin: spec.origin,
      });
      effects.push({ type: "task_created", taskId: task.id, title: task.title, owner: task.owner });
      await store.addEvent({
        surgeryId: surgery.id,
        type: "task_created",
        summary: `Task for ${task.owner}: ${task.title}`,
        actor: "agent",
        data: { taskId: task.id },
      });
      return true;
    }

    async function noteRequirementUpdate(req: Requirement, summary: string): Promise<void> {
      effects.push({ type: "requirement_updated", requirementId: req.id, key: req.key, status: req.status });
      await store.addEvent({
        surgeryId: surgery.id,
        type: "requirement_updated",
        summary,
        actor: "agent",
        data: { requirementId: req.id, key: req.key, status: req.status },
      });
    }

    // ---- Attachments first -------------------------------------------------
    let labDocumentReceived = false;
    let acceptableLabDocument = false;
    const attachmentMeta = attachments.map((a) => ({ mimeType: a.mimeType, documentId: null as string | null }));

    for (const [index, attachment] of attachments.entries()) {
      const mimeType = attachment.mimeType.toLowerCase();
      if (!mimeType.startsWith("image/") && mimeType !== "application/pdf") continue;

      const extraction = await llm.extractLabDocument({ mimeType, base64: attachment.base64 });
      const preop = await store.getRequirementByKey(surgery.id, "preop_labs");
      const preopActive = preop !== null && ACTIVE.has(preop.status);

      if (extraction.isLabReport) {
        labDocumentReceived = true;
        const assessment = assessLabDocument(extraction, {
          patientName: patient.displayName,
          surgeryDate: new Date(surgery.scheduledAt),
          now,
        });
        if (assessment.acceptable) acceptableLabDocument = true;

        const doc = await store.createDocument({
          surgeryId: surgery.id,
          requirementId: preopActive ? preop.id : null,
          messageId: inbound.id,
          mimeType,
          base64: attachment.base64,
          extracted: extraction,
          status: "needs_verification",
        });
        const meta = attachmentMeta[index];
        if (meta) meta.documentId = doc.id;
        effects.push({ type: "document_received", documentId: doc.id, requirementId: doc.requirementId, status: doc.status });
        await store.addEvent({
          surgeryId: surgery.id,
          type: "document_received",
          summary: assessment.summary,
          actor: "agent",
          data: { documentId: doc.id, acceptable: assessment.acceptable },
        });

        if (preopActive) {
          const evidence: Evidence = {
            type: "document",
            documentId: doc.id,
            messageId: inbound.id,
            summary: assessment.summary,
            checks: assessment.checks,
            data: { ...extraction },
          };
          const dated = extraction.collectedDate ? `dated ${extraction.collectedDate}` : "with no readable date";
          const updated = await store.updateRequirement(preop.id, {
            status: "evidence_received",
            reason: `The patient sent a lab report ${dated}. A staff member must verify it.`,
            evidence,
          });
          await noteRequirementUpdate(updated, "Lab report received from patient; waiting for staff to verify");
          await createTaskUnlessDuplicate({
            title: "Verify lab report from patient",
            owner: "nurse",
            detail: verifyDetail(assessment.summary, assessment.checks),
            requirementId: preop.id,
            origin: "document",
          });
          outgoing.push(replies.labReportReceived(first, assessment.checks));
        } else if (preop) {
          outgoing.push(replies.labAlreadyCovered(first));
        } else {
          outgoing.push(replies.labReportReceived(first, assessment.checks));
        }
      } else {
        const doc = await store.createDocument({
          surgeryId: surgery.id,
          requirementId: null,
          messageId: inbound.id,
          mimeType,
          base64: attachment.base64,
          extracted: extraction,
          status: "unreadable",
        });
        const meta = attachmentMeta[index];
        if (meta) meta.documentId = doc.id;
        effects.push({ type: "document_received", documentId: doc.id, requirementId: null, status: doc.status });
        await store.addEvent({
          surgeryId: surgery.id,
          type: "document_received",
          summary: "Patient sent a file that could not be read as a lab report",
          actor: "agent",
          data: { documentId: doc.id },
        });
        await createTaskUnlessDuplicate({
          title: "Review photo from patient",
          owner: "coordinator",
          detail: extraction.notes ?? "The attachment was not recognised as a lab report.",
          origin: "document",
        });
        outgoing.push(replies.photoUnreadable(first));
      }
    }
    if (attachmentMeta.some((m) => m.documentId)) {
      await store.updateMessage(inbound.id, { attachments: attachmentMeta });
    }

    // ---- Text --------------------------------------------------------------
    let classification: Classification | null = null;
    if (text) {
      const requirements = await store.listRequirements(surgery.id);
      const history = (await store.listMessages(surgery.id)).filter((m) => m.id !== inbound.id);
      classification = await llm.classifyReply({
        body: text,
        context: buildContext(surgery, first, requirements, history),
      });
      await store.updateMessage(inbound.id, { classification });

      const effectiveIntent = classification.confidence < MIN_CONFIDENCE ? "other" : classification.intent;
      const summary = classification.summary.trim() || clip(text, 160);
      const preop = requirements.find((r) => r.key === "preop_labs") ?? null;
      const transport = requirements.find((r) => r.key === "transport") ?? null;

      switch (effectiveIntent) {
        case "outside_result_claim": {
          if (acceptableLabDocument) break;
          await createTaskUnlessDuplicate({
            title: "Obtain outside lab result",
            owner: "coordinator",
            detail: summary,
            requirementId: preop?.id ?? null,
            origin: "patient_message",
          });
          // A lab report in this same message already got its own reply.
          if (!labDocumentReceived) outgoing.push(replies.askForReportPhoto(first));
          break;
        }

        case "transport_issue": {
          await createTaskUnlessDuplicate({
            title: "Arrange a ride home",
            owner: "coordinator",
            detail: summary,
            requirementId: transport?.id ?? null,
            origin: "patient_message",
          });
          if (transport && transport.status === "open") {
            const updated = await store.updateRequirement(transport.id, {
              reason: "The patient says they have no ride home.",
              source: { system: "patient_message", detail: summary },
            });
            await noteRequirementUpdate(updated, "Patient says they have no ride home");
          }
          outgoing.push(replies.rideHelp(first));
          break;
        }

        case "transport_confirmed": {
          if (transport && ACTIVE.has(transport.status)) {
            const updated = await store.updateRequirement(transport.id, {
              status: "evidence_received",
              reason: `The patient says ${statementOf(summary)}. A staff member must confirm.`,
              evidence: { type: "patient_statement", summary, messageId: inbound.id },
            });
            await noteRequirementUpdate(updated, "Patient reports a ride home; waiting for staff to confirm");
          }
          outgoing.push(replies.rideNoted(first));
          break;
        }

        case "health_concern": {
          const existing = requirements.find((r) => r.key === "health_review") ?? null;
          if (!existing || !ACTIVE.has(existing.status)) {
            const review = await store.upsertRequirement({
              surgeryId: surgery.id,
              key: "health_review",
              title: "New symptom reported",
              kind: "health",
              status: "open",
              blocking: true,
              owner: "nurse",
              reason: summary,
              source: { system: "patient_message", detail: summary },
              evidence: { type: "patient_statement", summary, messageId: inbound.id },
            });
            await noteRequirementUpdate(review, "Patient reported a new symptom; nurse review required");
          }
          const review = await store.getRequirementByKey(surgery.id, "health_review");
          await createTaskUnlessDuplicate({
            title: "Call patient about reported symptom",
            owner: "nurse",
            detail: summary,
            requirementId: review?.id ?? null,
            origin: "patient_message",
          });
          if (deps.onUrgent) {
            try {
              await deps.onUrgent({ surgeryId: surgery.id, summary, messageId: inbound.id });
            } catch (err) {
              // The nurse task and blocking requirement above still exist; never lose the reply.
              console.error("Could not raise the urgent alert", err);
            }
          }
          outgoing.push(replies.symptomCallback(first, clinic.phone));
          break;
        }

        case "question": {
          const topic = classification.faqTopic;
          const answer = topic ? replies.faqReply(topic, clinic.phone) : null;
          if (answer) {
            outgoing.push(answer);
          } else if (topic === "medications") {
            await createTaskUnlessDuplicate({
              title: "Patient question about medication",
              owner: "nurse",
              detail: text,
              origin: "patient_message",
              matchDetail: true,
            });
            outgoing.push(replies.medicationQuestion(first));
          } else {
            await createTaskUnlessDuplicate({
              title: "Patient question",
              owner: "coordinator",
              detail: text,
              origin: "patient_message",
              matchDetail: true,
            });
            outgoing.push(replies.questionPassedOn(first));
          }
          break;
        }

        case "acknowledgement": {
          const previous = history[history.length - 1];
          if (previous?.direction === "out") outgoing.push(replies.acknowledgementReply(first));
          break;
        }

        case "reschedule_request": {
          await createTaskUnlessDuplicate({
            title: "Patient asked to reschedule",
            owner: "coordinator",
            detail: summary,
            origin: "patient_message",
          });
          outgoing.push(replies.rescheduleCallback(first));
          break;
        }

        case "other": {
          // A bare greeting is not something for staff to review: answer it with what is still needed.
          if (isGreeting(text)) {
            outgoing.push(replies.greetingReply(first, requirements.filter((r) => ACTIVE.has(r.status)).map((r) => r.key)));
            break;
          }
          await createTaskUnlessDuplicate({
            title: "Review patient message",
            owner: "coordinator",
            detail: text,
            origin: "patient_message",
            matchDetail: true,
          });
          outgoing.push(replies.passedToTeam(first));
          break;
        }
      }
    }

    // ---- Save replies ------------------------------------------------------
    const sent = [...new Set(outgoing)];
    for (const reply of sent) {
      const saved = await store.createMessage({
        surgeryId: surgery.id,
        patientId: patient.id,
        direction: "out",
        channel: input.channel,
        body: reply,
        deliveryStatus: "sent",
      });
      await store.addEvent({
        surgeryId: surgery.id,
        type: "message_out",
        summary: `Agent replied: "${clip(reply, 80)}"`,
        actor: "agent",
        data: { messageId: saved.id },
      });
    }

    const result: InboundResult = {
      surgeryId: surgery.id,
      messageId: inbound.id,
      classification,
      replies: sent,
      effects,
    };
    return result;
  };
}

function buildContext(surgery: Surgery, first: string, requirements: Requirement[], history: Message[]): ConversationContext {
  return {
    patientFirstName: first,
    procedureName: surgery.procedureName,
    surgeryDate: surgery.scheduledAt.slice(0, 10),
    openRequirements: requirements.filter((r) => ACTIVE.has(r.status)).map((r) => ({ key: r.key, title: r.title })),
    recent: history.slice(-6).map((m) => ({ direction: m.direction, body: m.body })),
  };
}

function verifyDetail(summary: string, checks: { label: string; ok: boolean; detail: string }[]): string {
  const lines = checks.map((c) => `${c.ok ? "OK" : "CHECK"}: ${c.label} (${c.detail})`);
  return [summary, ...lines].join("\n");
}

/** "Patient says their daughter will drive them." becomes "their daughter will drive them". */
function statementOf(summary: string): string {
  const stripped = summary
    .replace(/^(the )?patient\s+(says|said|reports|reported|states|stated|wrote)\s*:?\s*(that\s+)?/i, "")
    .trim()
    .replace(/\.$/, "");
  return stripped || summary;
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}

const GREETING = /^(hi|hii+|hello|hey|heya|hiya|yo|good (morning|afternoon|evening)|morning|evening)( there)?[\s!.,]*$/i;

/** "hi", "Hello!", "good morning" — nothing for the care team to act on. */
export function isGreeting(text: string): boolean {
  return GREETING.test(text.trim());
}
