import type {
  Channel,
  DocumentRecord,
  EventRecord,
  Message,
  NewDocument,
  NewEvent,
  NewMessage,
  NewTask,
  Patient,
  Requirement,
  RequirementPatch,
  RequirementUpsert,
  SeedData,
  Store,
  Surgery,
  Task,
} from "../../types.ts";

/** Minimal in-memory Store for tests. Not used by the app. */
export function createMemoryStore(clockNow: () => Date = () => new Date()): Store & { documentContent: Map<string, { mimeType: string; base64: string }> } {
  const patients = new Map<string, Patient>();
  const surgeries = new Map<string, Surgery>();
  const requirements = new Map<string, Requirement>();
  const tasks = new Map<string, Task>();
  const messages = new Map<string, Message>();
  const documents = new Map<string, DocumentRecord>();
  const documentContent = new Map<string, { mimeType: string; base64: string }>();
  const events: EventRecord[] = [];
  let seq = 0;
  const id = (prefix: string) => `${prefix}_${++seq}`;
  const iso = () => clockNow().toISOString();
  const need = <T>(v: T | undefined, what: string): T => {
    if (v === undefined) throw new Error(`not_found: ${what}`);
    return v;
  };

  return {
    documentContent,

    async reset(seed: SeedData, now: Date) {
      for (const m of [patients, surgeries, requirements, tasks, messages, documents, documentContent]) m.clear();
      events.length = 0;
      const createdAt = now.toISOString();
      for (const p of seed.patients) {
        patients.set(p.id, { id: p.id, finchnodeSubject: p.finchnodeSubject, displayName: p.displayName, phone: p.phone, birthDate: p.birthDate, createdAt });
      }
      for (const s of seed.surgeries) {
        const [h = "0", m = "0"] = s.timeOfDay.split(":");
        const at = new Date(now.getTime() + s.daysFromNow * 86_400_000);
        at.setUTCHours(Number(h), Number(m), 0, 0);
        surgeries.set(s.id, {
          id: s.id, patientId: s.patientId, procedureCode: s.procedureCode, procedureName: s.procedureName,
          scheduledAt: at.toISOString(), location: s.location, surgeon: s.surgeon, status: "scheduled", lastCheckedAt: null, createdAt,
        });
      }
    },

    async listSurgeries() {
      return [...surgeries.values()].sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
    },
    async getSurgery(sid) {
      return surgeries.get(sid) ?? null;
    },
    async updateSurgery(sid, patch) {
      const next = { ...need(surgeries.get(sid), `surgery ${sid}`), ...patch };
      surgeries.set(sid, next);
      return next;
    },

    async getPatient(pid) {
      return patients.get(pid) ?? null;
    },
    async findPatientByPhone(phone) {
      return [...patients.values()].find((p) => p.phone === phone) ?? null;
    },
    async nextSurgeryForPatient(pid, now) {
      const upcoming = [...surgeries.values()]
        .filter((s) => s.patientId === pid && s.status === "scheduled" && new Date(s.scheduledAt) >= now)
        .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
      return upcoming[0] ?? null;
    },

    async listRequirements(sid) {
      return [...requirements.values()].filter((r) => r.surgeryId === sid);
    },
    async getRequirement(rid) {
      return requirements.get(rid) ?? null;
    },
    async getRequirementByKey(sid, key) {
      return [...requirements.values()].find((r) => r.surgeryId === sid && r.key === key) ?? null;
    },
    async upsertRequirement(input: RequirementUpsert) {
      const existing = [...requirements.values()].find((r) => r.surgeryId === input.surgeryId && r.key === input.key);
      const now = iso();
      const row: Requirement = {
        id: existing?.id ?? id("req"),
        surgeryId: input.surgeryId, key: input.key, title: input.title, kind: input.kind, status: input.status,
        blocking: input.blocking, owner: input.owner, reason: input.reason,
        source: input.source ?? null, proposal: input.proposal ?? null, evidence: input.evidence ?? null,
        verifiedBy: null, verifiedAt: null, staffNote: null,
        createdAt: existing?.createdAt ?? now, updatedAt: now,
      };
      requirements.set(row.id, row);
      return row;
    },
    async updateRequirement(rid, patch: RequirementPatch) {
      const next = { ...need(requirements.get(rid), `requirement ${rid}`), ...patch, updatedAt: iso() };
      requirements.set(rid, next);
      return next;
    },

    async listTasks(sid) {
      return [...tasks.values()].filter((t) => t.surgeryId === sid);
    },
    async getTask(tid) {
      return tasks.get(tid) ?? null;
    },
    async createTask(input: NewTask) {
      const task: Task = {
        id: id("tsk"), surgeryId: input.surgeryId, requirementId: input.requirementId ?? null, title: input.title,
        detail: input.detail ?? "", owner: input.owner, status: "open", origin: input.origin,
        createdAt: iso(), completedAt: null, completedBy: null,
      };
      tasks.set(task.id, task);
      return task;
    },
    async updateTask(tid, patch) {
      const next = { ...need(tasks.get(tid), `task ${tid}`), ...patch };
      tasks.set(tid, next);
      return next;
    },

    async listMessages(sid) {
      return [...messages.values()].filter((m) => m.surgeryId === sid);
    },
    async getMessage(mid) {
      return messages.get(mid) ?? null;
    },
    async createMessage(input: NewMessage) {
      const message: Message = {
        id: id("msg"), surgeryId: input.surgeryId, patientId: input.patientId, direction: input.direction, channel: input.channel,
        body: input.body, attachments: input.attachments ?? [], classification: input.classification ?? null,
        deliveryStatus: input.deliveryStatus, createdAt: iso(),
      };
      messages.set(message.id, message);
      return message;
    },
    async updateMessage(mid, patch) {
      const next = { ...need(messages.get(mid), `message ${mid}`), ...patch };
      messages.set(mid, next);
      return next;
    },
    async listOutbox(channel: Channel) {
      return [...messages.values()].filter((m) => m.direction === "out" && m.channel === channel && m.deliveryStatus === "queued");
    },

    async listDocuments(sid) {
      return [...documents.values()].filter((d) => d.surgeryId === sid);
    },
    async getDocument(did) {
      return documents.get(did) ?? null;
    },
    async createDocument(input: NewDocument) {
      const doc: DocumentRecord = {
        id: id("doc"), surgeryId: input.surgeryId, requirementId: input.requirementId ?? null, messageId: input.messageId ?? null,
        mimeType: input.mimeType, extracted: input.extracted ?? null, status: input.status, createdAt: iso(),
      };
      documents.set(doc.id, doc);
      documentContent.set(doc.id, { mimeType: input.mimeType, base64: input.base64 });
      return doc;
    },
    async updateDocument(did, patch) {
      const next = { ...need(documents.get(did), `document ${did}`), ...patch };
      documents.set(did, next);
      return next;
    },
    async getDocumentContent(did) {
      return documentContent.get(did) ?? null;
    },

    async listEvents(sid, limit) {
      const mine = events.filter((e) => e.surgeryId === sid).reverse();
      return limit === undefined ? mine : mine.slice(0, limit);
    },
    async addEvent(input: NewEvent) {
      const event: EventRecord = {
        id: id("evt"), surgeryId: input.surgeryId, type: input.type, summary: input.summary, actor: input.actor,
        data: input.data ?? null, createdAt: iso(),
      };
      events.push(event);
      return event;
    },
  };
}
