# Lakeshore One

Hospital operations suite for **VPS Lakeshore, Kochi** — built as self-contained
web apps, piloted on Claude artifacts (shared state) and hostable on GitHub Pages
(single-device demo mode).

## Apps

| Folder | App | What it does |
|---|---|---|
| `lakeshore-one/` | **Lakeshore One** (main) | Unified service desk: sign in with employee ID + PIN, raise IT / facility / housekeeping / biomedical / security tickets (ITIL incident vs service request), SLA targets by priority, agent queues, management dashboard with campus map, anonymous complaints channel (see below), admin user management + audit trail |
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

## Anonymous complaints ("Speak up")

A separate channel on the Raise tab for harassment, patient-safety, ethics
and similar concerns that staff would rather not put their name on. It runs
on a different trust model from tickets:

- **No identity is stored, anywhere.** The complaint record has no reporter
  fields, the submit operation carries no name/ID, and the audit trail only
  says a complaint was received "via the anonymous channel". Sign-in is used
  solely to keep the channel staff-only at submit time.
- **Follow-up via a one-time reference code**, generated on the submitter's
  device and shown once. Only its SHA-256 hash is stored, so nobody — not
  even a database reader — can link a code to a person. Checking status with
  the code is an unauthenticated request on purpose, so the lookup can't be
  tied to an account either (misses are rate-limited per IP).
- **Reviewed with discretion** by Management, Quality and Admin only, in a
  dedicated "Concerns" tab: new → in review → closed, with internal notes
  and optional responses shared back to the complainant through the code.
- **Honest limitation:** in the shared-artifact and single-device demo modes
  the data store is client-readable like everything else, so confidentiality
  of the complaint *content* is only enforced by the UI there; anonymity of
  the *submitter* holds in every mode because identity is simply never
  recorded. The backend server enforces reviewer-only visibility properly.

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
