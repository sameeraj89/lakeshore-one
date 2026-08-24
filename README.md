# Lakeshore One

Hospital operations suite for **VPS Lakeshore, Kochi** — built as self-contained
web apps, piloted on Claude artifacts (shared state) and hostable on GitHub Pages
(single-device demo mode).

## Apps

| Folder | App | What it does |
|---|---|---|
| `lakeshore-one/` | **Lakeshore One** (main) | Unified service desk: sign in with employee ID + PIN, raise IT / facility / housekeeping / biomedical / security tickets (ITIL incident vs service request), SLA targets by priority, agent queues, management dashboard with campus map, admin user management + audit trail |
| `patient-inputs/` | Patient Inputs | Voice-of-the-patient desk — capture complaints / suggestions / appreciation / queries at any touchpoint, Patient Experience triage board with response targets (high 24 h, medium 48 h, low 72 h), experience trends |
| `command-centre/` | Command Centre | The operations wall — one full-width screen (built for a TV) combining live discharges (most overdue first), bed-turnaround queue, beds-ready-by-ward, transport queue, open P1/P2 tickets with SLA countdowns, and a scrolling activity ticker from the audit trail. Reads everything from `/api/state` — no ops of its own; sign in with a management/quality/admin account to see the whole hospital |
| `discharge/` | Discharge Tracker | Advise-to-out clock for inpatient discharges — each hand-off (summary → pharmacy → bill → TPA → settlement → bed vacated) tapped done by the desk that owns it, per-step and total targets (3¾ h cash / 5¾ h insured), ward view of beds freeing up, step-bottleneck and bed-release-by-hour trends. Switches to the live shared board automatically when served by the backend (sign-in, server-enforced step order and roles, SSE) |
| `bed-turnaround/` | Bed Turnaround | Vacated-to-ready clock for every bed — housekeeping work queue (start cleaning ≤ 15 min, bed ready ≤ 45 min), tap-a-bed ward grids on the same occupied → dirty → cleaning → ready lifecycle as the main app's bed board, response-vs-cleaning split and per-ward turnaround trends. Switches to the live shared bed board automatically when served by the backend, where "patient out" on the Discharge Tracker drops the bed into this queue on its own |
| `porter/` | Porter Dispatch | Patient transport without phone calls — wards raise wheelchair / stretcher / bed / walk-with-escort / item-run requests with priority (Emergency jumps the queue), porters accept and run jobs (accept ≤ 10 min, done ≤ 30 min targets), dispatcher fleet view, response and busiest-route trends. Switches to the live shared board automatically when served by the backend (new `porter_agent` role — the porter who accepts owns the job) |
| `usg-wait/` | USG Wait | Ultrasound wait-time tracker — token queue per machine, register → start → complete taps, live estimated waits and auto room assignment, machine load view, hourly wait trends |
| `ot-schedule/` | OT Schedule | Operation theatre planning — book cases with table-clash checks (20-min turnover protected), six-theatre day timeline 07:00–21:00, case list with statuses, utilisation insights. Complements the live OT stage board inside the main app |
| `it-pulse/` | IT Pulse | Live campus IT monitoring map (network / Wi-Fi / servers / power / CCTV layers, 12-h zone trends) — simulated telemetry, adapter point documented in-page |
| `ops-desk/` | Ops Desk | Earlier shared incident board (superseded by Lakeshore One) |
| `safereport/` | SafeReport | Patient-safety incident reporting **mockup** — confidential/anonymous reporting, quality triage, RCA/CAPA worked example, safety trends. Kept separate from the service desk by design (different trust model) |

## Access control (pilot)

- Admin provisions users (employee ID, name, role, department); each user sets a
  4–6 digit PIN on first sign-in (stored as SHA-256, never plaintext).
- Roles gate the UI and actions: staff/doctor/nurse raise & track; agents work
  their desk's queue; management/quality see everything + dashboard; admin
  manages users and sees the audit trail.
- **Honest limitation:** enforcement is client-side and PINs are hashes in the
  shared store. Fine for a pilot; production needs hospital sign-on (AD/SSO) and
  a server — see `docs/schema.sql` for the target database schema.

## Priority / SLA matrix

| Priority | Respond | Resolve | Meant for |
|---|---|---|---|
| P1 Critical | 15 min | 4 h | Patient care blocked now (HIS down, O₂ alarm) |
| P2 High | 1 h | 8 h | Care or a department badly degraded |
| P3 Medium | 4 h | 24 h | Inconvenient but working |
| P4 Low | 1 d | 3 d | Routine requests |

A "patient care affected" toggle on every ticket auto-raises priority to at
least P2 — the healthcare-specific rule ITIL guides call out.

## Backend server (live multi-user system)

`server/server.js` is a zero-dependency Node.js (>= 22.5) backend: sign-in,
server-enforced roles, SQLite storage, live updates via SSE, and it serves
this same frontend. `node server/server.js` and the apps switch from demo
mode to the real system automatically. See `server/README.md` for the VPS
deployment guide (systemd + Caddy HTTPS, ~5 minutes) and `Dockerfile`.

## Data

The pilot stores everything in the artifact's `data/db.json` (users, tickets,
updates, audit), written with compare-and-set semantics and per-viewer
attribution. `docs/schema.sql` is the equivalent PostgreSQL schema for the
production build.

On GitHub Pages the apps run in **single-device demo mode** (localStorage) —
shared multi-user state works only through the Claude artifact links.
