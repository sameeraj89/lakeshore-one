-- =====================================================================
-- Lakeshore One — production database schema (PostgreSQL 14+)
-- Target state for the pilot's data model when it moves off the
-- artifact JSON store onto a hospital-hosted server.
-- The pilot's data/db.json maps 1:1 onto these tables.
-- =====================================================================

CREATE TYPE user_role AS ENUM (
  'doctor','nurse','staff',
  'it_agent','facility_agent','housekeeping_agent','biomedical_agent','security_agent',
  'management','quality','admin'
);

CREATE TYPE ticket_module AS ENUM ('it','fac','hk','bm','sec');
CREATE TYPE ticket_type   AS ENUM ('incident','request');           -- ITIL split
CREATE TYPE ticket_status AS ENUM ('open','in_progress','resolved','closed');
CREATE TYPE ticket_priority AS ENUM ('P1','P2','P3','P4');

CREATE TABLE users (
  emp_id        varchar(20) PRIMARY KEY,          -- hospital employee ID
  name          varchar(80)  NOT NULL,
  role          user_role    NOT NULL,
  department    varchar(80),
  -- Pilot uses SHA-256(app|emp_id|pin). Production: replace with
  -- AD / SSO (OIDC or SAML against hospital identity) and drop this column.
  pin_hash      char(64),
  active        boolean      NOT NULL DEFAULT true,
  created_at    timestamptz  NOT NULL DEFAULT now(),
  created_by    varchar(20)  REFERENCES users(emp_id)
);

CREATE TABLE tickets (
  id            varchar(16) PRIMARY KEY,          -- 'LSO-1042'
  module        ticket_module   NOT NULL,
  type          ticket_type     NOT NULL DEFAULT 'incident',
  category      varchar(60)     NOT NULL,         -- from the service catalog
  title         varchar(160)    NOT NULL,
  description   text,
  zone          varchar(60)     NOT NULL,         -- campus location
  priority      ticket_priority NOT NULL,
  patient_impact boolean        NOT NULL DEFAULT false,
  status        ticket_status   NOT NULL DEFAULT 'open',
  reporter      varchar(20)     NOT NULL REFERENCES users(emp_id),
  assignee      varchar(20)     REFERENCES users(emp_id),
  created_at    timestamptz     NOT NULL DEFAULT now(),
  responded_at  timestamptz,                      -- first agent action (SLA response)
  resolved_at   timestamptz,
  closed_at     timestamptz,
  due_respond   timestamptz     NOT NULL,         -- from the priority matrix
  due_resolve   timestamptz     NOT NULL
);
CREATE INDEX idx_tickets_queue  ON tickets (module, status, priority, created_at);
CREATE INDEX idx_tickets_mine   ON tickets (reporter, created_at DESC);
CREATE INDEX idx_tickets_zone   ON tickets (zone) WHERE status IN ('open','in_progress');

CREATE TABLE ticket_updates (
  id          bigserial PRIMARY KEY,
  ticket_id   varchar(16) NOT NULL REFERENCES tickets(id),
  kind        varchar(12) NOT NULL CHECK (kind IN ('comment','status','assign')),
  from_status ticket_status,
  to_status   ticket_status,
  body        text,
  author      varchar(20) NOT NULL REFERENCES users(emp_id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_updates_ticket ON ticket_updates (ticket_id, created_at);

CREATE TABLE audit_log (
  id          bigserial PRIMARY KEY,
  actor       varchar(20) NOT NULL,
  action      text        NOT NULL,
  ref         varchar(32),                        -- ticket id / emp id
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_time ON audit_log (created_at DESC);

-- Priority / SLA matrix (minutes) — kept as data so Quality can tune it
CREATE TABLE sla_matrix (
  priority       ticket_priority PRIMARY KEY,
  respond_mins   int NOT NULL,
  resolve_mins   int NOT NULL
);
INSERT INTO sla_matrix VALUES
  ('P1', 15, 240), ('P2', 60, 480), ('P3', 240, 1440), ('P4', 1440, 4320);

-- Service catalog — two-level, per ITIL practice
CREATE TABLE catalog (
  id        serial PRIMARY KEY,
  module    ticket_module NOT NULL,
  type      ticket_type   NOT NULL,
  category  varchar(60)   NOT NULL,
  active    boolean       NOT NULL DEFAULT true,
  UNIQUE (module, type, category)
);

-- ---------- Bed tracking ----------
CREATE TYPE bed_status AS ENUM ('occupied','dirty','cleaning','ready','blocked');
CREATE TABLE beds (
  bed_id     varchar(10) PRIMARY KEY,          -- '3A-01'
  ward       varchar(10) NOT NULL,             -- '3A', 'ICU', ...
  status     bed_status  NOT NULL DEFAULT 'ready',
  since      timestamptz,
  updated_by varchar(20) REFERENCES users(emp_id)
);
CREATE TABLE bed_events (                       -- turnaround-time source
  id       bigserial PRIMARY KEY,
  bed_id   varchar(10) NOT NULL REFERENCES beds(bed_id),
  from_st  bed_status, to_st bed_status NOT NULL,
  actor    varchar(20) NOT NULL REFERENCES users(emp_id),
  at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_bed_events ON bed_events (bed_id, at);

-- ---------- OT tracking ----------
CREATE TYPE ot_stage AS ENUM
  ('scheduled','in_ot','anaesthesia','incision','closure','out','cleaning','done','cancelled');
CREATE TABLE ot_cases (
  id        varchar(16) PRIMARY KEY,            -- 'OTC-104'
  suite     varchar(30) NOT NULL,               -- 'OT-1 · Cardiac'
  case_date date        NOT NULL,
  planned   time        NOT NULL,
  dur_min   int         NOT NULL,
  procedure varchar(120) NOT NULL,              -- procedure only; no patient names
  surgeon   varchar(60)  NOT NULL,
  status    ot_stage     NOT NULL DEFAULT 'scheduled',
  created_by varchar(20) REFERENCES users(emp_id)
);
CREATE TABLE ot_milestones (
  id       bigserial PRIMARY KEY,
  case_id  varchar(16) NOT NULL REFERENCES ot_cases(id),
  stage    ot_stage    NOT NULL,
  actor    varchar(20) NOT NULL REFERENCES users(emp_id),
  at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_ot_day ON ot_cases (case_date, suite, planned);
