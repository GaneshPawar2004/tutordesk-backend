# TutorDesk Backend — Remaining Work

Node.js + Express 5 REST API for the tuition SaaS. Part of three repos:
`tutordesk-app` (Flutter), `tutordesk-web` (React), `tutordesk-backend` (this).

## Current state

- **Working foundation with an in-memory store.** All data comes from a deterministic seed
  (`src/data/seed.js`: Bright Future Classes, 128 active students, 5 staff, 4 academic
  years, fees, attendance, exams, message batches). Everything resets on restart.
- **Demo auth only:** `POST /api/auth/demo-login` with `{ role: "admin" | "staff", staffId }`
  returns an HMAC-signed token (no password).
- The server enforces the rules:
  - staff get 403 on all fee routes and only see their assigned classes
  - permissions are re-read on every request, so revoking one takes effect immediately
  - one attendance session per class per day; a second submission gets 409; corrections
    are admin-only with an audit note
  - message batches are idempotent on a `sourceKey`; retry resends failed recipients only
  - payments are append-only and validated against the balance
  - promotion adds an enrollment and never duplicates the student; previous fees and
    dues are untouched
  - exam totals are computed from marks; correcting published marks needs a note and
    bumps the revision
- SMS sending is **simulated** with timers (`src/services/messaging.js`). Nothing is sent.
- `npm test`: 10 integration tests passing (Node's built-in test runner, real HTTP).

## Setup

```bash
npm install
cp .env.example .env     # optional; works without it
npm start                # http://localhost:4000
npm run dev              # with --watch
npm test
```

## Layout

```text
src/
  app.js              Express app factory (routes, JSON errors)
  server.js           entry point
  data/seed.js        demo dataset;  data/store.js  tenant-partitioned in-memory store
  middleware/auth.js  token → tenant + user (fresh permissions each request)
  routes/             auth, core (me/dashboard/years/classes/notifications), students
                      (+promotions), attendance, fees, staff, exams, messages
  services/           access rules, fee maths, result maths, message templates, messaging
test/api.test.js
```

## Remaining work (suggested order)

1. **Database.** Replace the in-memory store with PostgreSQL (recommended) and migrations
   (Prisma, Drizzle or Knex). Every table carries `tenant_id`. Add DB-level guarantees:
   - unique `(tenant_id, class_id, date)` on attendance sessions (the real lock)
   - unique `(tenant_id, source_key)` on message batches (the real idempotency)
   - unique `(tenant_id, student_id, academic_year_id)` on enrollments
   - payments insert-only (no UPDATE/DELETE grants), in transactions
2. **Real authentication and tenancy.** Phone OTP or password (hashed with argon2/bcrypt),
   access and refresh tokens, staff invitation flow (invite link → set password), tenant
   sign-up and subscription status. Remove or dev-gate `demo-login`.
3. **SMS transport.** Pick the provider model (Android SIM sender app polling a queue, or
   a gateway such as MSG91 or Twilio) and implement it behind the `dispatch` boundary in
   `services/messaging.js`. Add delivery-report webhooks, rate limits, DLT template
   registration (India), and per-tenant usage tracking. Only mark "delivered" on a real report.
4. **Missing endpoints:**
   - Reports (enrollment, attendance %, fee collection, dues, exam performance) with
     date-range, year and class filters
   - Edit exam metadata (`PATCH /api/exams/:id`); delete draft exams
   - Withdraw or re-activate an enrollment; student photo upload (object storage)
   - SMS settings update; notification creation on events (only the activity feed is
     written today)
   - Pagination and server-side search on list endpoints
5. **Hardening:** CORS allow-list for the web domain, `helmet`, rate limiting (auth
   especially), request logging with request IDs, input validation with a schema library
   (Zod), consistent error codes, OpenAPI/Swagger docs.
6. **Ops:** Dockerfile, environment config, health/readiness probes, backups, monitoring,
   CI running `npm test`.
7. **More tests** for each route's validation errors and the cross-tenant isolation case.

## Notes

- Money is whole rupees (integers). Dates are `YYYY-MM-DD` strings in local time;
  timestamps are ISO strings.
- `TOKEN_SECRET`: if unset or `change-me`, a random secret is generated at start, so
  tokens stop working after a restart (fine for local dev).
- `SMS_SIMULATION=off` disables the simulated sender (batches stay queued).
