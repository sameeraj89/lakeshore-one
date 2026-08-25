# TODOS

Deferred work with enough context to pick up months later. Added via
`/plan-eng-review` — keep entries in this format (What / Why / Pros / Cons /
Context / Depends on) so the reasoning survives, not just the bullet.

---

## 1. Connect Patient Inputs, USG Wait and OT Schedule to the backend

**What:** Wire the three standalone modules (`patient-inputs/`, `usg-wait/`,
`ot-schedule/`) to `server/server.js` so they become live multi-user systems
instead of single-browser demos.

**Why:** They are the operationally interesting modules, but today each one
stores data in `localStorage` — two staff members can't see the same queue,
which defeats the purpose the moment more than one person uses them.

**Pros:** Turns demos into real tools; the server, SSE stream, token auth and
role model already exist to plug into.

**Cons:** Each module needs its own tables, ops in `applyOp()`, role rules and
`buildState()` scoping — roughly the size of the original service-desk build
per module. Premature before pilot feedback confirms the UX is right.

**Context:** Each page is self-contained HTML with a small store function and
an in-page "single-device demo mode" note. `lakeshore-one/index.html` already
implements the demo-vs-server switch (probe `/api/health`, then `api()` +
SSE) — copy that adapter pattern. Add tables following the `ot_cases` /
`ot_milestones` precedent in `server/server.js`.

**Depends on:** pilot feedback on the three modules; the SSO/guest branch
merging first.

---

## 2. Stateless guest sessions (production hardening)

**What:** Stop creating a database user row at guest/patient sign-in; encode
the visitor role in the signed token and create a row only when the guest
raises their first ticket.

**Why:** The nightly cleanup added in the SSO branch treats the symptom
(ticketless rows accumulating); this removes the cause — the users table would
only ever hold people who did something.

**Pros:** Cleanest data model; no cleanup job to maintain; the audit log stops
recording no-op visits.

**Cons:** `verifyToken()` currently loads the user row to resolve the role, so
this touches token verification and every consumer that assumes a token maps
to a users row (`applyOp`, `buildState`, SSE auth) — a medium-risk auth
refactor for a pilot-scale problem that is already mitigated.

**Context:** See `sign()` / `verifyToken()` in `server/server.js`. A stateless
guest token would carry role + display-name claims; staff tokens keep the
DB-backed path. Do it alongside the AD/SSO work the README's scale-up path
already anticipates.

**Depends on:** the guest-cleanup stopgap being in production first; a
decision to move from pilot to production hardening.
