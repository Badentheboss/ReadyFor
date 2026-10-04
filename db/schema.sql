-- ReadyFor database schema. Postgres (Neon in production, PGlite in tests and no-config dev).
-- Column names are snake_case; the API returns the camelCase shapes in core/src/types.ts.
-- Safe to run repeatedly.

CREATE TABLE IF NOT EXISTS patients (
  id                 text PRIMARY KEY,
  finchnode_subject  text,
  display_name       text NOT NULL,
  phone              text,
  birth_date         date,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS patients_phone_idx ON patients (phone);

CREATE TABLE IF NOT EXISTS surgeries (
  id               text PRIMARY KEY,
  patient_id       text NOT NULL REFERENCES patients (id) ON DELETE CASCADE,
  procedure_code   text NOT NULL,
  procedure_name   text NOT NULL,
  scheduled_at     timestamptz NOT NULL,
  location         text NOT NULL,
  surgeon          text NOT NULL,
  status           text NOT NULL DEFAULT 'scheduled'
                   CHECK (status IN ('scheduled', 'cancelled', 'completed')),
  last_checked_at  timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS surgeries_patient_idx ON surgeries (patient_id, scheduled_at);

CREATE TABLE IF NOT EXISTS requirements (
  id           text PRIMARY KEY,
  surgery_id   text NOT NULL REFERENCES surgeries (id) ON DELETE CASCADE,
  key          text NOT NULL,
  title        text NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('lab', 'medication', 'logistics', 'instruction', 'health')),
  status       text NOT NULL CHECK (status IN ('open', 'evidence_received', 'satisfied', 'verified', 'waived')),
  blocking     boolean NOT NULL DEFAULT true,
  owner        text NOT NULL CHECK (owner IN ('coordinator', 'nurse', 'surgeon', 'patient')),
  reason       text NOT NULL DEFAULT '',
  source       jsonb,
  proposal     jsonb,
  evidence     jsonb,
  verified_by  text,
  verified_at  timestamptz,
  staff_note   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (surgery_id, key)
);

CREATE TABLE IF NOT EXISTS tasks (
  id              text PRIMARY KEY,
  surgery_id      text NOT NULL REFERENCES surgeries (id) ON DELETE CASCADE,
  requirement_id  text REFERENCES requirements (id) ON DELETE SET NULL,
  title           text NOT NULL,
  detail          text NOT NULL DEFAULT '',
  owner           text NOT NULL CHECK (owner IN ('coordinator', 'nurse', 'surgeon', 'patient')),
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
  origin          text NOT NULL CHECK (origin IN ('record_check', 'patient_message', 'document', 'staff', 'agent')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz,
  completed_by    text
);
CREATE INDEX IF NOT EXISTS tasks_surgery_idx ON tasks (surgery_id, created_at);

CREATE TABLE IF NOT EXISTS messages (
  id               text PRIMARY KEY,
  surgery_id       text NOT NULL REFERENCES surgeries (id) ON DELETE CASCADE,
  patient_id       text NOT NULL REFERENCES patients (id) ON DELETE CASCADE,
  direction        text NOT NULL CHECK (direction IN ('in', 'out')),
  channel          text NOT NULL CHECK (channel IN ('imessage', 'simulated', 'asione')),
  body             text NOT NULL,
  attachments      jsonb NOT NULL DEFAULT '[]'::jsonb,
  classification   jsonb,
  delivery_status  text NOT NULL CHECK (delivery_status IN ('queued', 'sent', 'received', 'failed')),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_surgery_idx ON messages (surgery_id, created_at);
CREATE INDEX IF NOT EXISTS messages_outbox_idx ON messages (channel, delivery_status, created_at);

CREATE TABLE IF NOT EXISTS documents (
  id              text PRIMARY KEY,
  surgery_id      text NOT NULL REFERENCES surgeries (id) ON DELETE CASCADE,
  requirement_id  text REFERENCES requirements (id) ON DELETE SET NULL,
  message_id      text REFERENCES messages (id) ON DELETE SET NULL,
  mime_type       text NOT NULL,
  content_base64  text NOT NULL,
  extracted       jsonb,
  status          text NOT NULL CHECK (status IN ('needs_verification', 'verified', 'rejected', 'unreadable')),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS documents_surgery_idx ON documents (surgery_id, created_at);

CREATE TABLE IF NOT EXISTS events (
  id          text PRIMARY KEY,
  surgery_id  text NOT NULL REFERENCES surgeries (id) ON DELETE CASCADE,
  type        text NOT NULL,
  summary     text NOT NULL,
  actor       text NOT NULL,
  data        jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS events_surgery_idx ON events (surgery_id, created_at DESC);

-- Upgrades for databases created before patient outreach was tracked. Safe to run on every start.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS delivery_error text;
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_delivery_status_check;
ALTER TABLE messages ADD CONSTRAINT messages_delivery_status_check CHECK (delivery_status IN ('queued', 'sent', 'received', 'failed'));
ALTER TABLE requirements ADD COLUMN IF NOT EXISTS outreach_message_id text REFERENCES messages (id) ON DELETE SET NULL;

-- Urgent escalation: the on-call ladder, alerts, and every notification sent for them.
CREATE TABLE IF NOT EXISTS staff_contacts (
  id            text PRIMARY KEY,
  name          text NOT NULL,
  role          text NOT NULL CHECK (role IN ('coordinator', 'nurse', 'surgeon', 'admin')),
  phone         text,
  on_call_rank  integer NOT NULL,
  active        boolean NOT NULL DEFAULT true
);
CREATE TABLE IF NOT EXISTS alerts (
  id                   text PRIMARY KEY,
  surgery_id           text NOT NULL REFERENCES surgeries (id) ON DELETE CASCADE,
  patient_id           text NOT NULL REFERENCES patients (id) ON DELETE CASCADE,
  kind                 text NOT NULL CHECK (kind IN ('health_concern')),
  summary              text NOT NULL,
  message_id           text REFERENCES messages (id) ON DELETE SET NULL,
  status               text NOT NULL CHECK (status IN ('open', 'acknowledged', 'resolved')),
  level                integer NOT NULL DEFAULT 0,
  notified_contact_id  text REFERENCES staff_contacts (id) ON DELETE SET NULL,
  notified_at          timestamptz,
  escalate_after       timestamptz,
  exhausted            boolean NOT NULL DEFAULT false,
  acknowledged_by      text,
  acknowledged_at      timestamptz,
  resolved_by          text,
  resolved_at          timestamptz,
  resolution           text,
  created_at           timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS alerts_due_idx ON alerts (status, escalate_after);
CREATE TABLE IF NOT EXISTS alert_notifications (
  id               text PRIMARY KEY,
  alert_id         text NOT NULL REFERENCES alerts (id) ON DELETE CASCADE,
  contact_id       text NOT NULL REFERENCES staff_contacts (id) ON DELETE CASCADE,
  level            integer NOT NULL,
  body             text NOT NULL,
  delivery_status  text NOT NULL CHECK (delivery_status IN ('queued', 'sent', 'failed')),
  delivery_error   text,
  created_at       timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS alert_notifications_queue_idx ON alert_notifications (delivery_status, created_at);
