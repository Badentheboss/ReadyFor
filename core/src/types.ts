/**
 * ReadyFor shared types. This file is the code half of docs/contract.md.
 *
 * Every module in core/ and imessage/ builds against these types, and the JSON
 * the HTTP API returns is exactly these shapes. Change this file only together
 * with docs/contract.md.
 */

// ---------------------------------------------------------------------------
// Domain
// ---------------------------------------------------------------------------

export type Id = string;
/** ISO 8601 timestamp, e.g. "2026-10-08T12:30:00.000Z". */
export type IsoDateTime = string;
/** Calendar date, "YYYY-MM-DD". */
export type IsoDate = string;

export type Owner = "coordinator" | "nurse" | "surgeon" | "patient";
export type SurgeryStatus = "scheduled" | "cancelled" | "completed";
export type RequirementKind = "lab" | "medication" | "logistics" | "instruction" | "health";

/**
 * open              nothing received yet
 * evidence_received the patient or a document supplied something; staff must verify it
 * satisfied         the health record itself meets the requirement; no human step needed
 * verified          a staff member confirmed it
 * waived            a staff member decided it does not apply (note required)
 */
export type RequirementStatus = "open" | "evidence_received" | "satisfied" | "verified" | "waived";
export type ReadinessLevel = "ready" | "needs_attention" | "at_risk";
export type Channel = "imessage" | "simulated" | "asione";
export type DrugClassTag = "anticoagulant" | "antiplatelet" | "diabetes";

export interface Patient {
  id: Id;
  /** Subject id in the FinchNode demo API, e.g. "patient-demo-polypharmacy". */
  finchnodeSubject: string | null;
  displayName: string;
  /** E.164, e.g. "+17345550100". */
  phone: string | null;
  birthDate: IsoDate | null;
  createdAt: IsoDateTime;
}

export interface Surgery {
  id: Id;
  patientId: Id;
  /** Key into the procedure requirement lists, e.g. "TKA". */
  procedureCode: string;
  procedureName: string;
  scheduledAt: IsoDateTime;
  location: string;
  surgeon: string;
  status: SurgeryStatus;
  /** When the record check last ran. */
  lastCheckedAt: IsoDateTime | null;
  createdAt: IsoDateTime;
}

/** Where a finding came from, so every flag is traceable. */
export interface RequirementSource {
  system: "finchnode" | "rxclass" | "patient_message" | "document" | "staff" | "rule";
  /** One human-readable line, e.g. "apixaban 5 MG Oral Tablet is ATC B01AF (Direct factor Xa inhibitors)". */
  detail: string;
  data?: Record<string, unknown>;
}

export interface EvidenceCheck {
  label: string;
  ok: boolean;
  detail: string;
}

export interface Evidence {
  type: "document" | "patient_statement" | "record";
  summary: string;
  documentId?: Id;
  messageId?: Id;
  /** Automatic checks the agent ran on the evidence, shown to the verifier. */
  checks?: EvidenceCheck[];
  data?: Record<string, unknown>;
}

/**
 * A staff-approved message template the agent selected for a medication.
 * The AI never writes medication instructions. `text` contains the literal
 * placeholder {{staff_instruction}} when `requiresStaffInstruction` is true;
 * the approver supplies that sentence.
 */
export interface TemplateProposal {
  templateKey: string;
  drugName: string;
  drugClass: DrugClassTag;
  text: string;
  requiresStaffInstruction: boolean;
}

export interface Requirement {
  id: Id;
  surgeryId: Id;
  /** Stable key, unique per surgery, e.g. "preop_labs", "anticoagulant_plan". */
  key: string;
  title: string;
  kind: RequirementKind;
  status: RequirementStatus;
  /** A blocking requirement keeps the surgery from being "ready" while open or evidence_received. */
  blocking: boolean;
  owner: Owner;
  /** One plain sentence explaining the current status. */
  reason: string;
  source: RequirementSource | null;
  proposal: TemplateProposal | null;
  evidence: Evidence | null;
  verifiedBy: string | null;
  verifiedAt: IsoDateTime | null;
  staffNote: string | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export type TaskOrigin = "record_check" | "patient_message" | "document" | "staff" | "agent";

export interface Task {
  id: Id;
  surgeryId: Id;
  requirementId: Id | null;
  title: string;
  detail: string;
  owner: Owner;
  status: "open" | "done";
  origin: TaskOrigin;
  createdAt: IsoDateTime;
  completedAt: IsoDateTime | null;
  completedBy: string | null;
}

export type Intent =
  | "outside_result_claim" // "I did that test at another clinic"
  | "transport_issue" // "I can't get a ride home"
  | "transport_confirmed" // "my daughter is driving me"
  | "health_concern" // "I've had a cough since Sunday"
  | "question" // "what can I eat the night before?"
  | "acknowledgement" // "ok thanks", "got it"
  | "reschedule_request"
  | "other";

export type FaqTopic = "fasting" | "arrival" | "what_to_bring" | "medications" | "none";

export interface Classification {
  intent: Intent;
  /** 0..1 */
  confidence: number;
  /** One short sentence restating what the patient said, written for staff. */
  summary: string;
  /** Requirement key the message relates to, if any. */
  requirementKey: string | null;
  faqTopic: FaqTopic | null;
}

export interface AttachmentMeta {
  mimeType: string;
  documentId: Id | null;
}

export interface Message {
  id: Id;
  surgeryId: Id;
  patientId: Id;
  direction: "in" | "out";
  channel: Channel;
  body: string;
  attachments: AttachmentMeta[];
  classification: Classification | null;
  /** in: always "received". out: "queued" until a channel adapter delivers it, then "sent". */
  deliveryStatus: "queued" | "sent" | "received";
  createdAt: IsoDateTime;
}

export interface LabResult {
  name: string;
  value: string;
  unit: string | null;
  flag: string | null;
}

export interface LabExtraction {
  isLabReport: boolean;
  patientName: string | null;
  collectedDate: IsoDate | null;
  facility: string | null;
  results: LabResult[];
  /** 0..1 */
  confidence: number;
  notes: string | null;
}

export type DocumentStatus = "needs_verification" | "verified" | "rejected" | "unreadable";

/** A file the patient sent. The bytes are fetched separately via GET /documents/:id/content. */
export interface DocumentRecord {
  id: Id;
  surgeryId: Id;
  requirementId: Id | null;
  messageId: Id | null;
  mimeType: string;
  extracted: LabExtraction | null;
  status: DocumentStatus;
  createdAt: IsoDateTime;
}

export interface EventRecord {
  id: Id;
  surgeryId: Id;
  /** e.g. "check_ran", "requirement_flagged", "message_in", "task_created", "requirement_verified". */
  type: string;
  summary: string;
  /** "agent", "patient", or a staff label such as "coordinator:Dana". */
  actor: string;
  data: Record<string, unknown> | null;
  createdAt: IsoDateTime;
}

export interface Readiness {
  level: ReadinessLevel;
  /** Blocking requirements that are open or evidence_received. */
  blockers: number;
  /** Blocking requirements that are open (nothing received yet). */
  openBlockers: number;
  /** Blocking requirements with evidence waiting for a staff member. */
  pendingVerification: number;
  /** Whole days from now until the surgery, never negative. */
  daysUntil: number;
  /** e.g. "At risk: 3 blockers, 5 days out". */
  headline: string;
}

// ---------------------------------------------------------------------------
// HTTP response shapes (see docs/contract.md)
// ---------------------------------------------------------------------------

export interface BlockerSummary {
  id: Id;
  key: string;
  title: string;
  status: RequirementStatus;
  owner: Owner;
  reason: string;
}

export interface SurgerySummary {
  surgery: Surgery;
  patient: Patient;
  readiness: Readiness;
  blockers: BlockerSummary[];
}

export interface SurgeryDetail {
  surgery: Surgery;
  patient: Patient;
  readiness: Readiness;
  requirements: Requirement[];
  tasks: Task[];
  messages: Message[];
  documents: DocumentRecord[];
  events: EventRecord[];
}

export type RequirementAction = "verify" | "approve_template" | "waive" | "reject_evidence" | "reopen";
export type TaskAction = "complete" | "reassign" | "reopen";

export interface ApiError {
  error: { code: string; message: string };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface RequirementUpsert {
  surgeryId: Id;
  key: string;
  title: string;
  kind: RequirementKind;
  status: RequirementStatus;
  blocking: boolean;
  owner: Owner;
  reason: string;
  source?: RequirementSource | null;
  proposal?: TemplateProposal | null;
  evidence?: Evidence | null;
}

export type RequirementPatch = Partial<
  Pick<
    Requirement,
    | "title"
    | "status"
    | "blocking"
    | "owner"
    | "reason"
    | "source"
    | "proposal"
    | "evidence"
    | "verifiedBy"
    | "verifiedAt"
    | "staffNote"
  >
>;

export interface NewTask {
  surgeryId: Id;
  requirementId?: Id | null;
  title: string;
  detail?: string;
  owner: Owner;
  origin: TaskOrigin;
}

export type TaskPatch = Partial<Pick<Task, "owner" | "status" | "completedAt" | "completedBy" | "detail">>;

export interface NewMessage {
  surgeryId: Id;
  patientId: Id;
  direction: "in" | "out";
  channel: Channel;
  body: string;
  attachments?: AttachmentMeta[];
  classification?: Classification | null;
  deliveryStatus: Message["deliveryStatus"];
}

export interface NewDocument {
  surgeryId: Id;
  requirementId?: Id | null;
  messageId?: Id | null;
  mimeType: string;
  base64: string;
  extracted?: LabExtraction | null;
  status: DocumentStatus;
}

export interface NewEvent {
  surgeryId: Id;
  type: string;
  summary: string;
  actor: string;
  data?: Record<string, unknown> | null;
}

/** Shape of db/seed/demo.json. */
export interface SeedData {
  patients: Array<{
    id: Id;
    finchnodeSubject: string | null;
    displayName: string;
    /** Literal phone, or the string "env:DEMO_PATIENT_PHONE". */
    phone: string | null;
    birthDate: IsoDate | null;
  }>;
  surgeries: Array<{
    id: Id;
    patientId: Id;
    procedureCode: string;
    procedureName: string;
    /** Scheduled this many days after the moment of seeding, at `timeOfDay` UTC. */
    daysFromNow: number;
    timeOfDay: string;
    location: string;
    surgeon: string;
    /** Requirements to insert as-is, for surgeries that are not checked live. */
    requirements?: Array<Omit<RequirementUpsert, "surgeryId"> & { verifiedBy?: string; staffNote?: string }>;
  }>;
}

/** All persistence goes through this interface. Implemented in core/src/store/. */
export interface Store {
  /** Drop all rows and load the seed. `now` anchors `daysFromNow`. */
  reset(seed: SeedData, now: Date): Promise<void>;

  listSurgeries(): Promise<Surgery[]>;
  getSurgery(id: Id): Promise<Surgery | null>;
  updateSurgery(id: Id, patch: Partial<Pick<Surgery, "status" | "lastCheckedAt">>): Promise<Surgery>;

  getPatient(id: Id): Promise<Patient | null>;
  findPatientByPhone(phone: string): Promise<Patient | null>;
  /** The patient's earliest scheduled surgery at or after `now`, or null. */
  nextSurgeryForPatient(patientId: Id, now: Date): Promise<Surgery | null>;

  listRequirements(surgeryId: Id): Promise<Requirement[]>;
  getRequirement(id: Id): Promise<Requirement | null>;
  getRequirementByKey(surgeryId: Id, key: string): Promise<Requirement | null>;
  /** Insert, or overwrite the row with the same (surgeryId, key). Fields omitted from the input are set to null. */
  upsertRequirement(input: RequirementUpsert): Promise<Requirement>;
  updateRequirement(id: Id, patch: RequirementPatch): Promise<Requirement>;

  listTasks(surgeryId: Id): Promise<Task[]>;
  getTask(id: Id): Promise<Task | null>;
  createTask(input: NewTask): Promise<Task>;
  updateTask(id: Id, patch: TaskPatch): Promise<Task>;

  listMessages(surgeryId: Id): Promise<Message[]>;
  getMessage(id: Id): Promise<Message | null>;
  createMessage(input: NewMessage): Promise<Message>;
  updateMessage(
    id: Id,
    patch: Partial<Pick<Message, "deliveryStatus" | "classification" | "attachments">>,
  ): Promise<Message>;
  /** Outbound messages on `channel` still queued, oldest first. */
  listOutbox(channel: Channel): Promise<Message[]>;

  listDocuments(surgeryId: Id): Promise<DocumentRecord[]>;
  getDocument(id: Id): Promise<DocumentRecord | null>;
  createDocument(input: NewDocument): Promise<DocumentRecord>;
  updateDocument(
    id: Id,
    patch: Partial<Pick<DocumentRecord, "requirementId" | "extracted" | "status">>,
  ): Promise<DocumentRecord>;
  getDocumentContent(id: Id): Promise<{ mimeType: string; base64: string } | null>;

  /** Newest first. */
  listEvents(surgeryId: Id, limit?: number): Promise<EventRecord[]>;
  addEvent(input: NewEvent): Promise<EventRecord>;
}

// ---------------------------------------------------------------------------
// Clinical inputs: health record and drug classes
// ---------------------------------------------------------------------------

export interface RecordMedication {
  name: string;
  status: string;
  /** RxNorm concept id when the record carries one. */
  rxcui: string | null;
  startDate: IsoDate | null;
}

export interface RecordCondition {
  name: string;
  status: string;
}

export interface RecordLab {
  name: string;
  value: string | null;
  unit: string | null;
  date: IsoDateTime | null;
}

/** A patient record normalised from the FinchNode demo API. */
export interface HealthRecord {
  subject: string;
  patientName: string | null;
  birthDate: IsoDate | null;
  medications: RecordMedication[];
  conditions: RecordCondition[];
  labs: RecordLab[];
  dataAsOf: IsoDateTime | null;
  synthetic: boolean;
  sourceNames: string[];
}

export interface RecordSource {
  getRecord(subject: string): Promise<HealthRecord>;
}

export interface DrugClassification {
  tags: DrugClassTag[];
  /** ATC classes returned for the drug. */
  classes: Array<{ classId: string; className: string }>;
  /** "rxclass" = live lookup; "local_fallback" = built-in ingredient table; "none" = unknown drug. */
  lookup: "rxclass" | "local_fallback" | "none";
  ingredient: string | null;
}

export interface DrugClassifier {
  classify(med: { name: string; rxcui: string | null }): Promise<DrugClassification>;
}

// ---------------------------------------------------------------------------
// Language model
// ---------------------------------------------------------------------------

export interface ConversationContext {
  patientFirstName: string;
  procedureName: string;
  surgeryDate: IsoDate;
  /** Requirements still open, so the model can link a reply to one. */
  openRequirements: Array<{ key: string; title: string }>;
  /** The last few messages, oldest first. */
  recent: Array<{ direction: "in" | "out"; body: string }>;
}

/**
 * The only two things the model does. It never decides readiness and never
 * writes medication instructions.
 */
export interface Llm {
  /** "gemini:<model>" or "fake". */
  readonly name: string;
  classifyReply(input: { body: string; context: ConversationContext }): Promise<Classification>;
  extractLabDocument(input: { mimeType: string; base64: string }): Promise<LabExtraction>;
}

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

export interface Clock {
  now(): Date;
}

export interface RecordCheckResult {
  surgeryId: Id;
  /** Requirement keys inserted by this run. */
  created: string[];
  /** Requirement keys whose status or reason changed in this run. */
  changed: string[];
  /** Messages queued for the patient by this run. */
  outbound: Message[];
  /** Non-fatal problems, e.g. "RxClass unreachable, used local fallback". */
  warnings: string[];
}

/** Reads the health record, applies the procedure's requirement list, and saves the result. Idempotent. */
export type RunRecordCheck = (surgeryId: Id) => Promise<RecordCheckResult>;

export interface InboundAttachment {
  mimeType: string;
  base64: string;
}

export interface InboundInput {
  channel: Channel;
  /** Identify the patient by phone, or name the surgery directly. One of the two is required. */
  phone?: string;
  surgeryId?: Id;
  body: string;
  attachments?: InboundAttachment[];
}

export type Effect =
  | { type: "task_created"; taskId: Id; title: string; owner: Owner }
  | { type: "requirement_updated"; requirementId: Id; key: string; status: RequirementStatus }
  | { type: "document_received"; documentId: Id; requirementId: Id | null; status: DocumentStatus };

export interface InboundResult {
  surgeryId: Id;
  messageId: Id;
  classification: Classification | null;
  /** Texts to send back to the patient, in order. Already saved as outbound messages. */
  replies: string[];
  effects: Effect[];
}

/** Thrown by handleInbound when no patient or surgery matches. */
export class UnknownSenderError extends Error {
  constructor(message = "No scheduled surgery matches this sender") {
    super(message);
    this.name = "UnknownSenderError";
  }
}

export type HandleInbound = (input: InboundInput) => Promise<InboundResult>;

export interface ClinicInfo {
  name: string;
  phone: string;
}

/** Everything the HTTP layer needs. Built in core/src/main.ts. */
export interface AppDeps {
  store: Store;
  clock: Clock;
  runRecordCheck: RunRecordCheck;
  handleInbound: HandleInbound;
  seed: () => SeedData;
  clinic: ClinicInfo;
  /** For GET /health. */
  info: { llm: string; database: "neon" | "memory"; records: "live" | "fixtures" };
}
