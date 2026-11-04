# Kaksha Backend

REST API for the Kaksha teachers app (Node.js + Express + PostgreSQL on [Neon](https://neon.tech)).

## Quick start

```bash
npm install
npm run dev:memory   # throwaway in-process Postgres (PGlite), nothing to install
```

The API runs at `http://localhost:4000/api/v1`. Without SMTP settings, OTP emails are
printed in this terminal (`[mail:dev] ... 123456 is your Kaksha verification code`).

For real data, point it at a Postgres database (e.g. a free Neon project):

```bash
cp .env.example .env      # then set NEON_DB_URL, TOKEN_SECRET, SMTP_*
npm run dev               # auto-restarts on code changes
npm start                 # production
npm test                  # API tests (in-process Postgres)
```

Tables are created on startup from [src/schema.sql](src/schema.sql) (every statement is
idempotent). IDs are UUIDs.

## Accounts and permissions

- **Owner**: signs up in the app; gets an *institute* with a 14-day trial. Sees everything.
- **Staff**: created by the owner (Users screen). Staff logins are free and unlimited; new staff start
  **active**, and the owner can block/unblock them.
  Staff can manage classes, students, attendance and tests. They see and collect fees only
  with **Can access Fees**. Deleting classes/students and managing users is owner-only.
- All data is scoped to the institute; other institutes' records always return 404.

## Access and the admin page

When an institute's trial ends, its owner and staff can still sign in, but every data route
returns `403 ACCESS_EXPIRED` (or `ACCESS_BLOCKED`) until you allow it. `/auth/me` and
`/account` keep working so the app can explain why and teachers can manage their account.

Open **`/admin`** (e.g. `https://tutordesk-backend.onrender.com/admin`) and sign in with
`ADMIN_API_KEY`. It lists every tuition with owner, students, staff and status, with buttons to:

- **Allow** (no end date, or for 1/3/6/12 months): owner and all staff get access.
- **Block**: owner and all staff lose access.
- **+7 days trial**: extend the free trial.

The page uses `GET /api/v1/admin/institutes?q=` and `PATCH /api/v1/admin/institutes/:id`
`{action: "allow"|"block"|"trial", accessUntil?, extendTrialDays?}` with header `x-admin-key`.
`SUPPORT_PHONE` / `SUPPORT_EMAIL` are shown in the app when access has ended.

## API

Send `Authorization: Bearer <token>` on every route except `/auth/*` (other than `/auth/me`).
Errors look like `{ "error": { "code": "NOT_FOUND", "message": "...", "details": [...] } }`.
Dates are `YYYY-MM-DD`; money is in rupees.

| Method | Path | Notes |
|---|---|---|
| POST | `/auth/register` | `{name, email, mobile, password, referralCode?}` → emails OTP |
| POST | `/auth/verify-email` | `{email, code}` → `{token, user, institute}` |
| POST | `/auth/resend-otp` | `{email, purpose: "signup"\|"reset"}` (30 s cooldown) |
| POST | `/auth/login` | `{identifier (email or mobile), password}` → `{token, user, institute}` |
| POST | `/auth/forgot-password` | `{email}` → emails OTP |
| POST | `/auth/verify-reset-otp` | `{email, code}` → `{resetToken}` (15 min) |
| POST | `/auth/reset-password` | `{resetToken, password}`; signs out all devices |
| GET | `/auth/me` | current user + institute (trial days, staff limit) |
| GET | `/dashboard?date=` | classes, students, presentToday, feesDue, trialDaysRemaining |
| GET / POST | `/classes` | list (with `studentCount`) / `{name}` |
| PATCH / DELETE | `/classes/:id` | rename / delete with all its data (owner) |
| GET / POST | `/classes/:classId/students` | `?includeDisabled=false` / add student |
| GET / PATCH / DELETE | `/students/:id` | PATCH any field incl. `disabled`; DELETE owner only |
| GET | `/students/:id/attendance` | history + present % |
| GET | `/students/:id/results` | marks in each test |
| GET / PUT | `/classes/:classId/attendance` | `?date=` (unsaved days default to present) / `{date, records:[{student, status}]}` |
| GET / POST | `/classes/:classId/tests` | list / `{subject, maxMarks}` |
| GET / PUT / DELETE | `/tests/:id` | PUT `{subject?, maxMarks?, marks:[{student, marks\|null, remarks, skip}]}` |
| GET | `/classes/:classId/fees` | summary + students *(fee access)* |
| GET | `/fees/dues` | pending fees across classes *(fee access)* |
| GET / POST | `/students/:id/fees/payments` | history / `{amount, note?, paidAt?}`; rejects overpayment *(fee access)* |
| GET / PUT / DELETE | `/students/:id/photo` | image / `{image: base64 JPEG or PNG}` (max 500 KB) / remove |
| PATCH | `/account` | `{name?, instituteName? (owner)}`; works even when access has ended |
| POST | `/account/password` | `{currentPassword, newPassword}` → new `token` (other devices signed out) |
| DELETE | `/account` | `{password}`, owner only: deletes the institute and everything in it |
| GET | `/reports` | attendance % and fee summary per class |
| GET / POST | `/users` | staff list with `activeCount` / create *(owner)* |
| PATCH / DELETE | `/users/:id` | edit, `active` (plan-limited), new password *(owner)* |

SMS is not handled by the server: the app opens the phone's SMS app and sends from the
teacher's own SIM.

## Deploying

Runs on Render via [render.yaml](render.yaml). Set `NODE_ENV=production`, a strong
`TOKEN_SECRET`, `NEON_DB_URL`, and SMTP credentials (e.g. Gmail app password, Brevo,
Amazon SES) so OTPs reach real inboxes.

- `GET /api/ping`: keep-alive for uptime pingers; never touches the database.
- `GET /api/health`: Render's health check; also runs `select 1`.

## Parent SMS queue

SMS go out from the teachers' own SIMs (the app), but every "send to all" list is first
saved on the server (`POST /sms/batches`). Each phone claims messages
(`POST /sms/claim {batch, limit}`, reserved for 10 minutes so two phones never send the same
one), reports each result (`POST /sms/:id/report {status: sent|failed}`) and gives back what
it could not send (`POST /sms/release {ids}`), e.g. when its daily SMS limit is used up.
`GET /sms/batches` lists the last 7 days with sent/remaining counts and who sent them;
`GET /sms/batches/:id` shows every student's status; unsent messages expire after 2 days
or can be dismissed (`POST /sms/batches/:id/dismiss`). Admin and all staff can use it.
