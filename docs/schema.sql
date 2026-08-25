-- =====================================================================
-- Lakeshore One — production database schema (PostgreSQL 14+)
-- Target state when the pilot moves off SQLite onto a managed database.
-- Table and column names track the live server (server/server.js). Two
-- differences are intentional:
--   1. This schema is normalized: it stores actor/author/reporter emp_ids with
--      FKs to users, and joins for display names. The pilot's flat store
--      denormalizes those names (reporter_name, assignee_name, author_name,
--      actor_name) alongside the ids.
--   2. `sla_matrix` and `catalog` are the production target; the single-file
--      pilot still hardcodes them (the PRI object and the frontend MODS
--      categories). Both are flagged inline below.
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
  tok_epoch     int          NOT NULL DEFAULT 0,  -- bumped on PIN reset to invalidate live sessions
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
  photo         text,                             -- pilot: inline data: URI; production: object-store key
  created_at    timestamptz     NOT NULL DEFAULT now(),
  responded_at  timestamptz,                      -- first agent action (SLA response)
  resolved_at   timestamptz,
  closed_at     timestamptz,                      -- production target; pilot derives closure from status
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
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_updates_ticket ON ticket_updates (ticket_id, at);

CREATE TABLE audit (
  id          bigserial PRIMARY KEY,
  actor       varchar(20) NOT NULL,
  action      text        NOT NULL,
  ref         varchar(32),                        -- production target: split ticket/emp id out (pilot inlines it in `action`)
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_time ON audit (at DESC);

-- TARGET-ONLY (pilot hardcodes the PRI object in server.js):
-- Priority / SLA matrix (minutes) — as data so Quality can tune it
CREATE TABLE sla_matrix (
  priority       ticket_priority PRIMARY KEY,
  respond_mins   int NOT NULL,
  resolve_mins   int NOT NULL
);
INSERT INTO sla_matrix VALUES
  ('P1', 15, 240), ('P2', 60, 480), ('P3', 240, 1440), ('P4', 1440, 4320);

-- TARGET-ONLY (pilot hardcodes categories in the frontend MODS object):
-- Service catalog — two-level, per ITIL practice
CREATE TABLE catalog (
  id        serial PRIMARY KEY,
  module    ticket_module NOT NULL,
  type      ticket_type   NOT NULL,
  category  varchar(60)   NOT NULL,
  active    boolean       NOT NULL DEFAULT true,
  UNIQUE (module, type, category)
);

-- ---------- Staff suggestion box ----------
-- Ideas to make Lakeshore a better place to work, submitted from the hub
-- landing page. No auth by design: anonymity encourages honest input.
CREATE TABLE ideas (
  id          bigserial PRIMARY KEY,
  idea        varchar(1000) NOT NULL,
  theme       varchar(40),                      -- e.g. 'Workplace & wellbeing'
  name        varchar(60),                      -- optional; blank = anonymous
  department  varchar(60),                      -- optional
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_ideas_time ON ideas (created_at DESC);

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
  procedure_name varchar(120) NOT NULL,         -- procedure only; no patient names
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

-- ---------- module apps: patient inputs / USG wait / OT bookings ----------
CREATE TYPE pi_type AS ENUM ('Complaint','Suggestion','Appreciation','Query');
CREATE TYPE pi_stage AS ENUM ('New','Acknowledged','In progress','Resolved','Closed');
CREATE TABLE patient_inputs (
  id           varchar(16) PRIMARY KEY,          -- 'PI-241'
  who          varchar(40) NOT NULL,             -- patient / bystander / staff on behalf
  type         pi_type     NOT NULL,
  sev          varchar(10),                      -- complaints only: High / Medium / Low
  place        varchar(60) NOT NULL,             -- touchpoint
  about        varchar(60) NOT NULL,             -- theme
  patient_name varchar(60),                      -- PII: Patient Experience team only
  uhid         varchar(20),
  descr        text        NOT NULL,
  stage        pi_stage    NOT NULL DEFAULT 'New',
  created_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at  timestamptz,
  created_by   varchar(20) REFERENCES users(emp_id)
);
CREATE INDEX idx_pi_stage ON patient_inputs (stage, created_at);

CREATE TYPE usg_status AS ENUM ('waiting','scanning','done','noshow');
CREATE TABLE usg_entries (
  id         varchar(16) PRIMARY KEY,            -- 'USG-242'
  token_no   varchar(8)  NOT NULL,               -- per-day token 'U-07'
  name       varchar(60),
  uhid       varchar(20),
  cls        varchar(12) NOT NULL,               -- OP / IP / Emergency
  room       varchar(10) NOT NULL,               -- USG-1..USG-4
  reg_at     timestamptz NOT NULL DEFAULT now(),
  start_at   timestamptz,                        -- wait = start_at - reg_at
  end_at     timestamptz,
  status     usg_status  NOT NULL DEFAULT 'waiting',
  created_by varchar(20) REFERENCES users(emp_id)
);
CREATE INDEX idx_usg_day ON usg_entries (reg_at);

CREATE TYPE otb_status AS ENUM ('booked','confirmed','in_ot','done','delayed','cancelled');
CREATE TABLE ot_bookings (                       -- planning board; live stages stay on ot_cases
  id         varchar(16) PRIMARY KEY,            -- 'OTB-243'
  case_date  date        NOT NULL,
  ot         varchar(10) NOT NULL,               -- OT-1..OT-6
  start      time        NOT NULL,               -- 07:00-21:00, 20-min turnover enforced
  dur_min    int         NOT NULL,
  patient    varchar(60) NOT NULL,
  uhid       varchar(20),
  procedure  varchar(120) NOT NULL,
  surgeon    varchar(60)  NOT NULL,
  anaes      varchar(20),
  prio       varchar(12),                        -- Elective / Emergency
  status     otb_status   NOT NULL DEFAULT 'booked',
  case_id    varchar(16) REFERENCES ot_cases(id),-- set on confirm: the case pushed to the live stage board
  created_by varchar(20) REFERENCES users(emp_id)
);
CREATE INDEX idx_otb_day ON ot_bookings (case_date, ot, start);

-- WhatsApp intake channel (server/whatsapp.js) ------------------------
CREATE TABLE wa_links (
  phone     varchar(20) PRIMARY KEY,               -- E.164 digits only
  emp_id    varchar(20) NOT NULL REFERENCES users(emp_id),
  linked_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE wa_messages (
  id        bigserial PRIMARY KEY,
  wamid     varchar(128) UNIQUE,                   -- Meta message id (webhook dedup)
  phone     varchar(20)  NOT NULL,
  direction varchar(3)   NOT NULL CHECK (direction IN ('in','out')),
  body      varchar(1000),
  ticket_id varchar(16) REFERENCES tickets(id),
  at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_wa_msg_phone ON wa_messages (phone, at DESC);
