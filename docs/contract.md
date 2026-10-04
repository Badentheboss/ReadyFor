# ReadyFor contract

This file and `core/src/types.ts` are the single agreement between the core service (Claude), the dashboard and Fetch.ai agent (Codex), and the iMessage adapter. If you need something changed, change this file first, then the code.

## 1. Who owns what

| Folder | Owner | What lives there |
| --- | --- | --- |
| `docs/contract.md`, `core/src/types.ts`, `db/schema.sql` | Claude | The contract |
| `core/` | Claude | HTTP API, record check, conversation logic |
| `imessage/` | Claude | Photon Spectrum adapter (a separate process that calls the core over HTTP) |
| `db/seed/demo.json` | Claude | Demo patients and surgeries |
| `dashboard/` | Codex | Coordinator web page |
| `agent/` | Codex | Python uAgent for ASI:One |
| `db/seed/assets/` | Codex | Sample lab report image for the demo |
| `README.md` | Codex | Setup and submission notes |

Nobody edits another owner's folder. Root `package.json` belongs to Claude; `dashboard/` and `agent/` carry their own dependency files.

## 2. Running the core

```
bun install
bun start            # http://localhost:8787
```

It runs with an empty `.env`:

| Variable | Unset behaviour |
| --- | --- |
| `DATABASE_URL` | In-memory database, seeded on start, lost on restart |
| `GEMINI_API_KEY` | Keyword-based fake model; no real AI |
| `RECORD_FIXTURES` | Live FinchNode and RxClass calls (set to `1` for offline fixtures) |
| `DEMO_PATIENT_PHONE` | Harriet has no phone, so iMessage cannot reach her; the simulated channel still works |
| `NEON_AUTH_BASE_URL` | Auth is off: every caller is trusted and `actor` comes from the request body. Local use only |

`GET /health` reports which of these modes is active. Set `AUTH_REQUIRED=1` anywhere the core is reachable by others; it then refuses to start with auth off.

## 3. Conventions

- Base URL `http://localhost:8787`. JSON in and out. With auth off, CORS is open to any origin; with auth on, only `CORS_ORIGINS` (default `http://localhost:4173`).
- Authentication is described in section 9. Synthetic data only.
- Timestamps are ISO 8601 UTC strings. Dates are `YYYY-MM-DD`.
- Ids are opaque strings with a prefix: `pat_`, `sur_`, `req_`, `tsk_`, `msg_`, `doc_`, `evt_`.
- `actor` is a label for who did something: `"coordinator:Dana"`, `"nurse:Priya"`, `"nurse:Priya via ASI:One"`, `"patient"`. With auth on the core derives it from the caller and ignores any `actor` in the body.
- Errors use one envelope and a matching HTTP status:

```json
{ "error": { "code": "invalid_transition", "message": "Cannot verify a requirement that is already verified" } }
```

| Status | `code` values |
| --- | --- |
| 400 | `bad_request`, `note_required` |
| 401 | `unauthorized` (no credential, or an invalid or expired one) |
| 403 | `forbidden` (valid credential without permission, or a Neon account not on the staff list) |
| 404 | `not_found`, `unknown_sender` |
| 409 | `invalid_transition` |
| 502 | `upstream_failed` (FinchNode unreachable and no fixture) |

## 4. The model in one page

A **surgery** belongs to a **patient**. The record check gives the surgery a list of **requirements**. A requirement that is `blocking` and not yet cleared is a **blocker**. Staff clear blockers; the agent never does.

Requirement status:

| Status | Meaning | Counts as a blocker (if `blocking`) |
| --- | --- | --- |
| `open` | Nothing received yet | Yes |
| `evidence_received` | The patient sent something; a staff member must verify it | Yes |
| `satisfied` | The health record itself meets it | No |
| `verified` | A staff member confirmed it | No |
| `waived` | A staff member decided it does not apply | No |

Requirement keys for a knee replacement (`procedureCode` `TKA`):

| Key | Kind | Blocking | Appears when | Default owner |
| --- | --- | --- | --- | --- |
| `preop_labs` | lab | yes | Always. Needs hemoglobin, platelets, creatinine, and potassium dated within 30 days before surgery. | nurse |
| `a1c_recent` | lab | no | The record lists diabetes. Needs an A1c within 90 days before surgery. | nurse |
| `anticoagulant_plan` | medication | yes | An active medication is an anticoagulant (looked up in RxClass). | surgeon |
| `antiplatelet_plan` | medication | no | An active medication is an antiplatelet, such as aspirin. | nurse |
| `diabetes_med_plan` | medication | no | An active medication is a diabetes drug. | nurse |
| `transport` | logistics | yes | Always. | coordinator |
| `fasting_ack` | instruction | no | Always. | patient |
| `health_review` | health | yes | The patient reports a new symptom in a message. | nurse |

Medication requirements carry a `proposal`: a staff-written template the agent picked for the drug class. The agent never writes medication instructions. Where the template has `requiresStaffInstruction: true`, its text contains the literal `{{staff_instruction}}`, and the approver must supply that sentence as `note`.

### Readiness

Computed on every read, never stored. `blockers` are blocking requirements with status `open` or `evidence_received`.

1. No requirements and never checked: `needs_attention`, headline `"Not checked yet"`.
2. `blockers == 0`: `ready`, headline `"Ready"`.
3. Any blocker of kind `health`: `at_risk`.
4. `daysUntil <= 2`: `at_risk`.
5. `openBlockers >= 2` and `daysUntil <= 7`: `at_risk`.
6. Otherwise: `needs_attention`.

`daysUntil` is whole days from now to `scheduledAt`, rounded up, never below 0. Headlines read `"At risk: 3 blockers, 5 days out"` or `"Needs attention: 1 blocker, 12 days out"`.

## 5. Routes

### GET /health

```json
{ "ok": true, "time": "2026-10-03T20:00:00.000Z", "llm": "fake", "database": "memory", "records": "live" }
```

### GET /surgeries

All surgeries, soonest first. Response `{ "surgeries": SurgerySummary[] }`.

```json
{
  "surgeries": [
    {
      "surgery": {
        "id": "sur_morgan", "patientId": "pat_morgan", "procedureCode": "TKA",
        "procedureName": "Total knee replacement (left)", "scheduledAt": "2026-10-06T14:00:00.000Z",
        "location": "Northstar Surgical Center, OR 1", "surgeon": "Dr. Avery Demo",
        "status": "scheduled", "lastCheckedAt": null, "createdAt": "2026-10-03T20:00:00.000Z"
      },
      "patient": {
        "id": "pat_morgan", "finchnodeSubject": "patient-demo-001", "displayName": "Morgan Rivera",
        "phone": null, "birthDate": "1988-04-17", "createdAt": "2026-10-03T20:00:00.000Z"
      },
      "readiness": {
        "level": "ready", "blockers": 0, "openBlockers": 0, "pendingVerification": 0,
        "daysUntil": 3, "headline": "Ready"
      },
      "blockers": []
    },
    {
      "surgery": { "id": "sur_harriet", "patientId": "pat_harriet", "procedureCode": "TKA",
        "procedureName": "Total knee replacement (right)", "scheduledAt": "2026-10-08T12:30:00.000Z",
        "location": "Northstar Surgical Center, OR 3", "surgeon": "Dr. Avery Demo",
        "status": "scheduled", "lastCheckedAt": "2026-10-03T20:01:00.000Z", "createdAt": "2026-10-03T20:00:00.000Z" },
      "patient": { "id": "pat_harriet", "finchnodeSubject": "patient-demo-polypharmacy",
        "displayName": "Harriet Lindqvist", "phone": "+17345550100", "birthDate": "1948-03-02",
        "createdAt": "2026-10-03T20:00:00.000Z" },
      "readiness": { "level": "at_risk", "blockers": 3, "openBlockers": 3, "pendingVerification": 0,
        "daysUntil": 5, "headline": "At risk: 3 blockers, 5 days out" },
      "blockers": [
        { "id": "req_a1", "key": "anticoagulant_plan", "title": "Blood thinner plan", "status": "open",
          "owner": "surgeon", "reason": "Apixaban is an anticoagulant and no pause plan is on file." },
        { "id": "req_a2", "key": "preop_labs", "title": "Pre-op blood work within 30 days", "status": "open",
          "owner": "nurse", "reason": "The newest blood work is from 2026-07-14, 86 days before surgery." },
        { "id": "req_a3", "key": "transport", "title": "Ride home confirmed", "status": "open",
          "owner": "coordinator", "reason": "The patient has not confirmed who will drive them home." }
      ]
    }
  ]
}
```

### GET /surgeries/:id

Response is a `SurgeryDetail`: `{ surgery, patient, readiness, requirements, tasks, messages, documents, events, outreach, alerts, schedule }`. `GET /surgeries` summaries also carry `schedule: { level, headline }`. Lists are oldest first, except `events`, which is newest first and capped at 50. A requirement in full:

```json
{
  "id": "req_a1", "surgeryId": "sur_harriet", "key": "anticoagulant_plan", "title": "Blood thinner plan",
  "kind": "medication", "status": "open", "blocking": true, "owner": "surgeon",
  "reason": "Apixaban is an anticoagulant and no pause plan is on file.",
  "source": {
    "system": "rxclass",
    "detail": "Apixaban 5 MG Oral Tablet is ATC B01AF (Direct factor Xa inhibitors)",
    "data": { "rxcui": "1364445", "classId": "B01AF", "className": "Direct factor Xa inhibitors", "lookup": "rxclass" }
  },
  "proposal": {
    "templateKey": "anticoagulant_pause", "drugName": "Apixaban 5 MG Oral Tablet", "drugClass": "anticoagulant",
    "text": "Hi Harriet, a note from your surgical team about your blood thinner (apixaban). {{staff_instruction}} Please do not stop or change this medicine unless your care team has told you to. Questions? Call Northstar Surgical Center at (734) 555-0100.",
    "requiresStaffInstruction": true
  },
  "evidence": null, "verifiedBy": null, "verifiedAt": null, "staffNote": null,
  "createdAt": "2026-10-03T20:01:00.000Z", "updatedAt": "2026-10-03T20:01:00.000Z"
}
```

A lab requirement after the patient texts a photo:

```json
{
  "key": "preop_labs", "status": "evidence_received",
  "reason": "The patient sent a lab report dated 2026-09-29. A staff member must verify it.",
  "evidence": {
    "type": "document", "documentId": "doc_k2", "messageId": "msg_p9",
    "summary": "Lab report from Quillhaven Medical Group, collected 2026-09-29, 6 results.",
    "checks": [
      { "label": "Collected within 30 days of surgery", "ok": true, "detail": "9 days before surgery" },
      { "label": "Patient name matches", "ok": true, "detail": "Harriet Lindqvist" },
      { "label": "Required results present", "ok": true, "detail": "hemoglobin, platelets, creatinine, potassium" }
    ]
  }
}
```

### GET /surgeries/:id/brief

A plain-text summary for chat surfaces such as ASI:One. Response `{ "text": "..." }`:

```
Harriet Lindqvist, Total knee replacement (right), Thu Oct 8. At risk: 3 blockers, 5 days out.
1. Blood thinner plan (surgeon): Apixaban is an anticoagulant and no pause plan is on file.
2. Pre-op blood work within 30 days (nurse): The newest blood work is from 2026-07-14, 86 days before surgery.
3. Ride home confirmed (coordinator): The patient has not confirmed who will drive them home.
Open tasks: none.
```

### POST /surgeries/:id/check

Runs the record check: reads the FinchNode record, classifies medications through RxClass, applies the requirement list, saves the result, and queues a first message to the patient if something needs their input. No request body. Safe to call repeatedly: it never downgrades a requirement that is `evidence_received`, `verified`, or `waived`.

Response:

```json
{
  "detail": { "...": "SurgeryDetail" },
  "result": {
    "surgeryId": "sur_harriet",
    "created": ["preop_labs", "a1c_recent", "anticoagulant_plan", "antiplatelet_plan", "diabetes_med_plan", "transport", "fasting_ack"],
    "changed": [],
    "outbound": [ { "...": "Message" } ],
    "warnings": []
  }
}
```

### POST /requirements/:id/actions

Request `{ "action": RequirementAction, "actor": string, "note"?: string }`.

| Action | Allowed from | Result | `note` |
| --- | --- | --- | --- |
| `verify` | `open`, `evidence_received` | `verified`; a linked document becomes `verified` | optional |
| `approve_template` | `open` on a requirement with a `proposal` | `verified`; the template is queued for the patient with `{{staff_instruction}}` replaced by `note`, and its delivery is tracked in `outreach` | required when `requiresStaffInstruction` |
| `waive` | `open`, `evidence_received` | `waived` | required |
| `reject_evidence` | `evidence_received` | `open`; the linked document becomes `rejected` | required |
| `reopen` | `verified`, `waived`, `satisfied` | `open` | optional |

Any other combination returns 409 `invalid_transition`. A missing required note returns 400 `note_required`.

Response:

```json
{ "requirement": { "...": "Requirement" }, "readiness": { "...": "Readiness" }, "outbound": [] }
```

`outbound` lists messages queued for the patient by the action (one for `approve_template`, otherwise empty).

### POST /tasks

Request `{ "surgeryId": string, "title": string, "owner": Owner, "detail"?: string, "requirementId"?: string, "actor"?: string, "origin"?: "staff" | "agent" }`. `origin` defaults to `"staff"`. Response `{ "task": Task }`, status 201.

### GET /tasks

Tasks across every surgery, for a "My tasks" view. Query `owner` (`coordinator`, `nurse`, `surgeon`, `patient`) and `status` (`open` default, `done`, `all`). Sorted by surgery date, then creation. Each task adds `patientName`, `procedureName` and `scheduledAt`. Response `{ "tasks": [...] }`. Needs `read`.

### POST /tasks/:id/actions

Request `{ "action": "complete" | "reassign" | "reopen", "actor": string, "owner"?: Owner }`. `reassign` requires `owner`. Response `{ "task": Task }`.

`complete` and `reassign` apply to an open task, `reopen` to a done one; anything else returns 409 `invalid_transition`.

Completing a task does not clear its requirement. Clearing is always an explicit requirement action.

### POST /messages/inbound

One message from the patient. Used by the iMessage adapter, and by the dashboard to simulate the patient when iMessage is not available.

Request:

```json
{
  "channel": "simulated",
  "surgeryId": "sur_harriet",
  "body": "I did that test at another clinic last week",
  "attachments": [ { "mimeType": "image/jpeg", "base64": "..." } ]
}
```

Give `surgeryId`, or give `phone` and the core finds the patient's next surgery. `attachments` is optional; images and PDFs up to 6 MB each are read as possible lab reports. No match returns 404 `unknown_sender`.

Response:

```json
{
  "surgeryId": "sur_harriet",
  "messageId": "msg_p9",
  "classification": {
    "intent": "outside_result_claim", "confidence": 0.93,
    "summary": "Patient says the blood work was done at another clinic last week.",
    "requirementKey": "preop_labs", "faqTopic": null
  },
  "replies": [ "Thanks, Harriet. If you have the results, text me a photo of the report and I will pass it to your care team." ],
  "effects": [
    { "type": "task_created", "taskId": "tsk_1", "title": "Obtain outside lab result", "owner": "coordinator" }
  ]
}
```

`replies` are already saved as outbound messages. On the `simulated` and `asione` channels they are marked `sent`, because the caller shows them. On `imessage` the adapter sends them and they are marked `sent` as well.

What each intent does:

| Intent | Example | Effect |
| --- | --- | --- |
| `outside_result_claim` | "I did that test at another clinic" | Task for the coordinator to obtain the result; asks for a photo |
| `transport_issue` | "I can't get a ride home" | Task for the coordinator; `transport` stays open with a new reason |
| `transport_confirmed` | "My daughter is driving me" | `transport` becomes `evidence_received` |
| `health_concern` | "I've had a cough since Sunday" | Creates blocking `health_review`; task for the nurse |
| `question` | "What can I eat the night before?" | Answers from the clinic's fixed instructions; anything about medication becomes a nurse task instead of an answer |
| `acknowledgement` | "Got it" | No change |
| `reschedule_request` | "Can we move the date?" | Task for the coordinator |
| `other` | | Task for the coordinator if the message is not empty |

An attachment that reads as a lab report sets `preop_labs` to `evidence_received` with the checks shown above. A photo that is not a lab report is stored with status `unreadable` and creates a coordinator task.

### GET /outbox?channel=imessage

Outbound messages waiting to be delivered, oldest first. `channel` defaults to `imessage`. Response `{ "messages": Array<Message & { "phone": string | null }> }`.

### POST /outbox/:id/sent

Marks a queued message as sent. No body. Response `{ "message": Message }`.

### POST /outbox/:id/failed

The adapter gave up on a queued message (after 3 attempts). Request `{ "error"?: string }`. The message becomes `failed`, leaves the outbox, and stays visible to staff in `outreach`. Only a `queued` outbound message can fail; anything else is 409. Response `{ "message": Message }`.

### POST /messages/:id/retry

Staff put a `failed` message back in the outbox. No body needed. Anything but `failed` is 409. Response `{ "message": Message }`.

### Outreach

Approving a template is the clinical decision, so it clears the requirement and counts toward readiness at once. Whether the patient was actually told is shown separately, in `SurgeryDetail.outreach`, one entry per approved requirement:

```json
{ "requirementId": "req_a1", "messageId": "msg_q4", "deliveryStatus": "failed",
  "deliveryError": "Recipient is not reachable on iMessage", "acknowledgedAt": null }
```

`deliveryStatus` is `queued`, `sent` or `failed`. `acknowledgedAt` is the time of the first patient reply classified as `acknowledgement` after the message. Reopening the requirement removes its entry. A failed send never changes readiness; it stays on the card until someone retries it.

### GET /documents/:id/content

The stored file, with its own `Content-Type`. Use it as an `<img src>`.

### POST /demo/reset

Clears everything and reloads `db/seed/demo.json`, with surgery dates set relative to now. No body. Response `{ "ok": true, "surgeries": 3 }`.

After a reset Harriet's surgery has no requirements and reads "Not checked yet". Press the check button to produce the flags live.

## 6. Demo state

| Surgery id | Patient | In | State after reset | State after `POST /surgeries/sur_harriet/check` |
| --- | --- | --- | --- | --- |
| `sur_morgan` | Morgan Rivera | 3 days | Ready | Ready |
| `sur_harriet` | Harriet Lindqvist | 5 days | Not checked yet | At risk: 3 blockers |
| `sur_jordan` | Jordan Ellis | 12 days | Needs attention: 1 blocker | Needs attention: 1 blocker |

Harriet is FinchNode's `polypharmacy-senior` scenario: 78 years old, on apixaban and aspirin, with her newest blood work dated 2026-07-14. All flags come from her real synthetic record.

## 7. Notes for the dashboard

- Poll `GET /surgeries` every 3 seconds for the list, and `GET /surgeries/:id` for the open surgery. There is no websocket.
- Show `readiness.headline` and colour by `readiness.level`.
- Buttons map to requirement actions: Verify, Approve and send (with a text box for the staff instruction), Reject evidence, Waive.
- Show `source.detail` under each flag. It is the proof that the finding came from the record and not from the model.
- Show `evidence.checks` as a checklist beside the photo from `GET /documents/:id/content`.
- A "Message as patient" box that posts to `/messages/inbound` with `channel: "simulated"` makes the whole demo work without iMessage.

## 8. Notes for the Fetch.ai agent

The coordinator flow in ASI:One needs four calls:

1. `GET /surgeries` to answer "what is at risk this week?"
2. `GET /surgeries/:id/brief` to answer "what is blocking Harriet's surgery?"
3. `POST /tasks` with `origin: "agent"` to assign a follow-up.
4. `POST /requirements/:id/actions` to verify, once the coordinator confirms in chat.

The core must be reachable from wherever the agent runs. Locally that means a tunnel to port 8787.

## 9. Authentication (Neon Auth)

Auth is on when the core has `NEON_AUTH_BASE_URL`. Every route except `GET /health` then needs `Authorization: Bearer <token>`. There are three kinds of caller.

**Staff** sign in through Neon Auth (Managed Better Auth) in the dashboard, using `@neondatabase/auth`. The dashboard gets a JWT with `authClient.token()` (it expires after 15 minutes, so fetch a fresh one before each call or on a 401) and sends it as the bearer token. The core verifies it against the branch JWKS (EdDSA; issuer and audience are the Auth URL's origin). A valid Neon account grants nothing on its own: the account must match an entry in `STAFF_ALLOWLIST`, by user id (`id:<sub>`) or by email once the email is verified. The entry gives the person's role and display name. Roles: `coordinator`, `nurse`, `surgeon`, `admin`.

**The iMessage adapter** sends `IMESSAGE_SERVICE_TOKEN`.

**The Fetch.ai agent** sends `AGENT_SERVICE_TOKEN` and, on every call, `X-ReadyFor-Sender: <ASI:One sender address>`. The agent acts only for a sender linked to a staff entry (the fourth field of the entry), with that person's role. An unlinked sender gets 403 on every route, reads included, because anyone can message the agent.

| Permission | coordinator | nurse / surgeon | admin | iMessage adapter | agent (linked sender) |
| --- | --- | --- | --- | --- | --- |
| Read surgeries, briefs, documents | yes | yes | yes | no | yes |
| `POST /surgeries/:id/check` | yes | yes | yes | no | no |
| Requirement actions on `logistics` and `instruction` | yes | yes | yes | no | as the linked person |
| Requirement actions on `lab`, `medication`, `health` | **no** | yes | yes | no | as the linked person |
| `POST /tasks`, `POST /tasks/:id/actions` | yes | yes | yes | no | as the linked person |
| `POST /messages/inbound` with `simulated` or `asione` | yes | yes | yes | no | no |
| `POST /messages/inbound` with `imessage` | no | no | no | yes | no |
| `GET /outbox`, `POST /outbox/:id/sent`, `POST /outbox/:id/failed` | no | no | yes | yes | no |
| `POST /messages/:id/retry` | yes | yes | yes | no | no |
| `GET /alerts` | yes | yes | yes | no | yes |
| `POST /alerts/:id/acknowledge` | yes | yes | yes | no | as the linked person |
| `POST /alerts/:id/resolve` | **no** | yes | yes | no | no |
| `POST /demo/reset` | no | no | yes | no | no |

### GET /me

Who the core thinks the caller is. Use it after sign-in to show the name and role, and to hide buttons the role cannot use.

```json
{ "identity": { "kind": "staff", "role": "nurse", "name": "Priya", "userId": "860dc360-..." }, "actor": "nurse:Priya", "auth": "neon" }
```

With auth off: `{ "identity": { "kind": "open" }, "actor": null, "auth": "off" }`.

### Notes for the dashboard

- `GET /documents/:id/content` needs the bearer token too, so an `<img src>` cannot load it directly. Fetch it with the header and show it through `URL.createObjectURL`.
- On 401, refresh the token once and retry; if it fails again, show the sign-in screen. On 403, show the message from the error envelope.
- Stop sending `actor`; the core ignores it when auth is on.
- Register the dashboard's deployed origin as a Neon Auth trusted domain (`neon neon-auth domain add <origin>`) and add it to `CORS_ORIGINS`.

### Notes for the agent

- Send `Authorization: Bearer $AGENT_SERVICE_TOKEN` and `X-ReadyFor-Sender: <sender>` on every request, using the ASI:One sender of the chat message being handled.
- A 403 means the sender is not linked, or their role cannot do that action. Tell them so; do not retry.

## 10. Urgent escalation

A message classified `health_concern` raises an **alert** in addition to the blocking `health_review` requirement and the nurse task. The patient is told the concern was sent to the care team as urgent; they are not promised a call.

The **on-call ladder** is `staff_contacts`, ordered by `onCallRank`. The demo ladder comes from `db/seed/demo.json` (`staff`) and is re-synced on every start, so `ONCALL_PRIMARY_PHONE`, `ONCALL_BACKUP_PHONE` and `ONCALL_LAST_PHONE` in `.env` take effect without a reset. `DEMO_PATIENT_PHONE` is re-applied on start the same way.

1. The first contact is texted at once. Staff texts travel through `GET /outbox?channel=imessage` with ids starting `ntf_`, so the adapter sends, retries and reports them like patient messages (`POST /outbox/:id/sent|failed`). A contact with no phone gets a `failed` notification and the clock keeps running.
2. If nobody acknowledges within `ESCALATION_MINUTES` (default 5), the next contact is texted. The core checks every `ESCALATION_CHECK_SECONDS` (default 20).
3. After the last contact, the alert is marked `exhausted` and an `alert_unanswered` event is written.
4. **Acknowledge** from the dashboard or ASI:One, or by replying `ACK` (also `ok`, `yes`, `on it`) from the paged phone. Escalation stops, and only now is the patient texted the name of the person who has it.
5. **Resolve** with a required note (clinical roles).

A second symptom message while an alert is live joins it (`alert_updated`) instead of paging again. If one phone is both a demo patient and an on-call contact, only an `ACK` while an alert is open is treated as staff; everything else is the patient.

### GET /alerts

Active alerts, newest first; `?status=all` includes resolved ones. Response `{ "alerts": AlertView[] }`:

```json
{ "id": "alr_k2", "surgeryId": "sur_harriet", "patientName": "Harriet Lindqvist", "procedureName": "Total knee replacement (right)",
  "summary": "Patient reports chest pain since this morning", "status": "open", "level": 0, "exhausted": false,
  "notified": { "name": "Priya Shah", "role": "nurse" }, "notifiedAt": "2026-10-04T03:10:00.000Z",
  "escalateAfter": "2026-10-04T03:15:00.000Z", "next": { "name": "Dr. Avery Demo", "role": "surgeon" },
  "acknowledgedBy": null, "acknowledgedAt": null, "resolvedBy": null, "resolution": null,
  "notifications": [ { "contactName": "Priya Shah", "contactRole": "nurse", "level": 0, "deliveryStatus": "sent", "deliveryError": null } ] }
```

### POST /alerts/:id/acknowledge

No body needed. `open` → `acknowledged`; anything else is 409. Response `{ "alert": AlertView }`.

### POST /alerts/:id/resolve

Request `{ "note": string }` (required, 400 `note_required` otherwise). Response `{ "alert": AlertView }`.

Events: `alert_raised`, `alert_notified`, `alert_escalated`, `alert_notification_failed`, `alert_updated`, `alert_acknowledged`, `alert_resolved`, `alert_unanswered`.

## 11. Schedule indicators

`schedule` comes from a synthetic FHIR R4 `Appointment` feed (`core/src/clinical/fixtures/schedule.json`) and is never part of readiness. Rules:

| Item | Conflict | Needs attention |
| --- | --- | --- |
| Operating room booking | missing, not `booked`, or more than 15 minutes from `scheduledAt` | |
| Pre-op clinic visit | | missing, not confirmed, or within 24 hours of surgery |
| Anesthesia consult | | required at age 65 or older and not booked |

Each item cites its source: `{ "system": "fhir", "resource": "Appointment/harriet-or-case", "lastUpdated": "..." }`. Levels: `on_track`, `needs_attention`, `conflict`, `unknown` (no feed data).

## 12. Operations

- `GET /health` (public): modes in use.
- `GET /ready` (public): `200 { ok: true }` only when the database answers; `503` otherwise. Use it for container and load-balancer health checks.
- Gemini: `GEMINI_MODEL` (default `gemini-3.8-flash`) with `GEMINI_FALLBACK_MODELS` tried in order on 429/503/404. Classification failures are logged and fall back to keywords; extraction failures leave the photo for staff review.

## 13. Scheduled recheck and re-review

Every `RECHECK_INTERVAL_MINUTES` (default 60), the core rechecks each surgery in the next `RECHECK_HORIZON_DAYS` (default 56, matching the dashboard's widest window) whose last record check is older than `RECHECK_AFTER_HOURS` (default 24). Surgeries never checked are skipped, so the first patient text is always a staff action. `POST /recheck` (admin) runs it now for every upcoming checked surgery and returns `{ checked, findings, errors }`.

- A new or changed **open** requirement becomes one task, `Recheck: <title>`, for its owner, and a `recheck_findings` event.
- If the health record changes behind a requirement staff already verified, waived or are reviewing, the decision stands; the record check reports the key in `needsReview`, logs `requirement_needs_review`, and creates one `Re-review: <title>` task.
- Verified or pending lab evidence whose `evidence.data.collectedDate` falls outside its window for the surgery date (30 days for `preop_labs`, 90 for `a1c_recent`), for example after a reschedule, logs `evidence_stale` once and creates a `Re-review` task.
- Reruns are safe: patient outreach is never repeated, tasks are deduplicated by title and requirement, and stale-evidence findings are logged once per collection date and surgery time.

