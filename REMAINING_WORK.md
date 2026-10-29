# TutorDesk Backend — Status & Remaining Work

Node.js 22 + Express 5 + PostgreSQL (Neon). Part of three repos:
`tutordesk-app` (Flutter), `tutordesk-web` (React), `tutordesk-backend` (this).

## Setup

```bash
npm install
cp .env.example .env      # put your Neon URL in NEON_DB_URL (or DATABASE_URL)
npm start                 # http://localhost:4000 — also prints the LAN address for phones
npm test                  # integration tests in a throwaway Postgres schema (dropped after)
```

On start the server creates/updates tables (idempotent) and, if missing, appends a
random `TOKEN_SECRET` to `.env`.

## What works

- **Real data in Postgres.** Every row carries `tenant_id`; tenants are fully isolated.
  New tuitions start empty (no sample data).
- **Real accounts.** `POST /api/auth/register` (tuition + admin; creates the current
  academic year and 6 default subjects), `POST /api/auth/login` (phone or email +
  password, scrypt-hashed), `POST /api/auth/accept-invite` (staff set their own
  password with the admin's invite code). 30-day signed tokens. The user row is
  re-read on every request, so permission changes apply immediately.
- **Rules enforced by the database/server:** one attendance session per class per day
  (unique constraint; 409 on a second save, even if simultaneous); admin-only audited
  corrections; staff get 403 on fees/staff; staff only see assigned classes; one
  message batch per source (unique constraint) and retry resends failures only;
  payments append-only and locked against overpaying; promotion adds an enrollment
  without duplicating the student or touching last year's fee; exam totals computed;
  published-mark corrections need a note and bump the revision.
- `GET /api/sync` returns everything the signed-in user may see — used by the mobile app.
- **SMS transport per tenant** (`tenants.sms.mode`, `src/services/messaging.js`): `simulated` (default,
  nothing reaches parents) or `device` — an admin's Android phone running the app claims queued
  messages (`POST /api/sms-device/claim`), sends from its SIM and reports back
  (`POST /api/sms-device/report`). Switch with `PUT /api/messages/sms-settings`. Claimed but
  unreported messages fail after 10 minutes and are never re-sent automatically.

## Remaining work

1. **SMS:** optional gateway transport (e.g. MSG91 with Indian DLT templates) next to the
   Android SIM sender; per-tenant daily limits; tests for the device endpoints.
2. **Account features:** "forgot password" (today: admin creates a new invite code for
   staff; there is no self-service reset for the admin), changing password while
   logged in, sign-out of all devices.
3. **Endpoints not built yet:** reports (attendance %, collections, dues, exam
   performance with filters), delete/withdraw flows, student photo upload, pagination
   and server-side search on large lists, editing SMS settings.
4. **Scaling:** `/api/sync` sends the whole tenant; fine for a single tuition, but move
   the app to paginated endpoints for large tenants.
5. **Hardening:** CORS allow-list (currently reflects any origin), helmet, rate limiting
   on auth routes, structured logs, schema validation library, OpenAPI docs.
6. **Ops:** deploy to a server (Render/Railway/VPS) with HTTPS so the app works outside
   your Wi‑Fi; backups; CI running `npm test`.
