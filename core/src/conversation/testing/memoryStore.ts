import type {
  Channel,
  DocumentRecord,
  EventRecord,
  Id,
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
  TaskPatch,
} from "../../types.ts";

/** A small in-memory Store for tests. Not the real store; it only has to behave like one. */
export function createMemoryStore(opts: { now?: () => Date } = {}): Store & {
  addPatient(p: Patient): void;
  addSurgery(s: Surgery): void;
  addRequirement(r: Requirement): void;
} {
  const now = opts.now ?? (() => new Date());
  const patients = new Map<Id, Patient>();
  const surgeries = new Map<Id, Surgery>();
  const requirements = new Map<Id, Requirement>();
  const tasks = new Map<Id, Task>();
  const messages = new Map<Id, Message>();
  const documents = new Map<Id, DocumentRecord>();
  const contents = new Map<Id, { mimeType: string; base64: string }>();
  const events: EventRecord[] = [];
  const counters: Record<string, number> = {};

  const nextId = (prefix: string) => {
    counters[prefix] = (counters[prefix] ?? 0) + 1;
    return `${prefix}_${counters[prefix]}`;
  };
  const stamp = () => now().toISOString();
  const need = <T>(value: T | undefined, what: string, id: string): T => {
    if (value === undefined) throw new Error(`${what} not found: ${id}`);
    return value;
  };
  const bySurgery = <T extends { surgeryId: Id }>(map: Map<Id, T>, surgeryId: Id) => [...map.values()].filter((x) => x.surgeryId === surgeryId);

  return {
    addPatient: (p) => void patients.set(p.id, p),
    addSurgery: (s) => void surgeries.set(s.id, s),
    addRequirement: (r) => void requirements.set(r.id, r),

    async reset(seed: SeedData, at: Date) {
      for (const m of [patients, surgeries, requirements, tasks, messages, documents, contents]) m.clear();
      events.length = 0;
      for (const p of seed.patients) {
        patients.set(p.id, { id: p.id, finchnodeSubject: p.finchnodeSubject, displayName: p.displayName, phone: p.phone, birthDate: p.birthDate, createdAt: at.toISOString() });
      }
      for (const s of seed.surgeries) {
        const [h = "0", m = "0"] = s.timeOfDay.split(":");
        const when = new Date(at.getTime() + s.daysFromNow * 86_400_000);
        when.setUTCHours(Number(h), Number(m), 0, 0);
        surgeries.set(s.id, {
          id: s.id, patientId: s.patientId, procedureCode: s.procedureCode, procedureName: s.procedureName,
          scheduledAt: when.toISOString(), location: s.location, surgeon: s.surgeon, status: "scheduled",
          lastCheckedAt: null, createdAt: at.toISOString(),
        });
      }
    },

    async listSurgeries() {
      return [...surgeries.values()].sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
    },
    async getSurgery(id) {
      return surgeries.get(id) ?? null;
    },
    async updateSurgery(id, patch) {
      const next = { ...need(surgeries.get(id), "Surgery", id), ...patch };
      surgeries.set(id, next);
      return next;
    },

    async getPatient(id) {
      return patients.get(id) ?? null;
    },
    async findPatientByPhone(phone) {
      return [...patients.values()].find((p) => p.phone === phone) ?? null;
    },
    async nextSurgeryForPatient(patientId, at) {
      const upcoming = [...surgeries.values()]
        .filter((s) => s.patientId === patientId && s.status === "scheduled" && new Date(s.scheduledAt) >= at)
        .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
      return upcoming[0] ?? null;
    },

    async listRequirements(surgeryId) {
      return bySurgery(requirements, surgeryId);
    },
    async getRequirement(id) {
      return requirements.get(id) ?? null;
    },
    async getRequirementByKey(surgeryId, key) {
      return bySurgery(requirements, surgeryId).find((r) => r.key === key) ?? null;
    },
    async upsertRequirement(input: RequirementUpsert) {
      const existing = bySurgery(requirements, input.surgeryId).find((r) => r.key === input.key);
      const at = stamp();
      const row: Requirement = {
        id: existing?.id ?? nextId("req"),
        surgeryId: input.surgeryId,
        key: input.key,
        title: input.title,
        kind: input.kind,
        status: input.status,
        blocking: input.blocking,
        owner: input.owner,
        reason: input.reason,
        source: input.source ?? null,
        proposal: input.proposal ?? null,
        evidence: input.evidence ?? null,
        verifiedBy: null,
        verifiedAt: null,
        staffNote: null,
        createdAt: existing?.createdAt ?? at,
        updatedAt: at,
      };
      requirements.set(row.id, row);
      return row;
    },
    async updateRequirement(id, patch: RequirementPatch) {
      const next = { ...need(requirements.get(id), "Requirement", id), ...patch, updatedAt: stamp() };
      requirements.set(id, next);
      return next;
    },

    async listTasks(surgeryId) {
      return bySurgery(tasks, surgeryId);
    },
    async getTask(id) {
      return tasks.get(id) ?? null;
    },
    async createTask(input: NewTask) {
      const task: Task = {
        id: nextId("tsk"), surgeryId: input.surgeryId, requirementId: input.requirementId ?? null, title: input.title,
        detail: input.detail ?? "", owner: input.owner, status: "open", origin: input.origin,
        createdAt: stamp(), completedAt: null, completedBy: null,
      };
      tasks.set(task.id, task);
      return task;
    },
    async updateTask(id, patch: TaskPatch) {
      const next = { ...need(tasks.get(id), "Task", id), ...patch };
      tasks.set(id, next);
      return next;
    },

    async listMessages(surgeryId) {
      return bySurgery(messages, surgeryId);
    },
    async getMessage(id) {
      return messages.get(id) ?? null;
    },
    async createMessage(input: NewMessage) {
      const message: Message = {
        id: nextId("msg"), surgeryId: input.surgeryId, patientId: input.patientId, direction: input.direction,
        channel: input.channel, body: input.body, attachments: input.attachments ?? [],
        classification: input.classification ?? null, deliveryStatus: input.deliveryStatus, createdAt: stamp(),
      };
      messages.set(message.id, message);
      return message;
    },
    async updateMessage(id, patch) {
      const next = { ...need(messages.get(id), "Message", id), ...patch };
      messages.set(id, next);
      return next;
    },
    async listOutbox(channel: Channel) {
      return [...messages.values()].filter((m) => m.direction === "out" && m.channel === channel && m.deliveryStatus === "queued");
    },

    async listDocuments(surgeryId) {
      return bySurgery(documents, surgeryId);
    },
    async getDocument(id) {
      return documents.get(id) ?? null;
    },
    async createDocument(input: NewDocument) {
      const doc: DocumentRecord = {
        id: nextId("doc"), surgeryId: input.surgeryId, requirementId: input.requirementId ?? null,
        messageId: input.messageId ?? null, mimeType: input.mimeType, extracted: input.extracted ?? null,
        status: input.status, createdAt: stamp(),
      };
      documents.set(doc.id, doc);
      contents.set(doc.id, { mimeType: input.mimeType, base64: input.base64 });
      return doc;
    },
    async updateDocument(id, patch) {
      const next = { ...need(documents.get(id), "Document", id), ...patch };
      documents.set(id, next);
      return next;
    },
    async getDocumentContent(id) {
      return contents.get(id) ?? null;
    },

    async listEvents(surgeryId, limit) {
      const rows = events.filter((e) => e.surgeryId === surgeryId).reverse();
      return limit ? rows.slice(0, limit) : rows;
    },
    async addEvent(input: NewEvent) {
      const event: EventRecord = {
        id: nextId("evt"), surgeryId: input.surgeryId, type: input.type, summary: input.summary,
        actor: input.actor, data: input.data ?? null, createdAt: stamp(),
      };
      events.push(event);
      return event;
    },
  };
}
