# Lakeshore One

Hospital operations suite for **VPS Lakeshore, Kochi** — built as self-contained
web apps, piloted on Claude artifacts (shared state) and hostable on GitHub Pages
(single-device demo mode).

## Apps

| Folder | App | What it does |
|---|---|---|
| `lakeshore-one/` | **Lakeshore One** (main) | Unified service desk: sign in with employee ID + PIN, raise IT / facility / housekeeping / biomedical / security tickets (ITIL incident vs service request), SLA targets by priority, agent queues, management dashboard with campus map, admin user management + audit trail |
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

## Data

The pilot stores everything in the artifact's `data/db.json` (users, tickets,
updates, audit), written with compare-and-set semantics and per-viewer
attribution. `docs/schema.sql` is the equivalent PostgreSQL schema for the
production build.

On GitHub Pages the apps run in **single-device demo mode** (localStorage) —
shared multi-user state works only through the Claude artifact links.
