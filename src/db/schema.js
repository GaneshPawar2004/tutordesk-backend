/**
 * Database schema. Idempotent: safe to run on every start. Every row carries
 * tenant_id; uniqueness constraints are what actually enforce the business
 * rules (one attendance session per class per day, one message batch per
 * source, one enrollment per student per year, one fee plan per enrollment).
 */
export const SCHEMA = `
create table if not exists tenants (
  id text primary key,
  name text not null,
  city text not null default '',
  address text not null default '',
  phone text not null default '',
  email text not null default '',
  student_seq integer not null default 0,
  sms jsonb not null default '{"mode":"simulated","deviceName":"","monthlyAllowance":0,"usedThisMonth":0}',
  created_at timestamptz not null default now()
);

create table if not exists users (
  id text primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  role text not null check (role in ('admin', 'staff')),
  name text not null,
  email text,
  phone text not null,
  password_hash text,
  designation text not null default '',
  permissions text[] not null default '{}',
  assigned_class_ids text[] not null default '{}',
  is_active boolean not null default true,
  account_status text not null default 'active' check (account_status in ('active', 'invitationPending')),
  invite_code text,
  joined_on date not null default current_date,
  created_at timestamptz not null default now()
);
create unique index if not exists users_phone_uq on users (phone);
create unique index if not exists users_email_uq on users (lower(email)) where email is not null and email <> '';

create table if not exists academic_years (
  id text primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  label text not null,
  start_date date not null,
  end_date date not null,
  status text not null check (status in ('active', 'upcoming', 'closed')),
  unique (tenant_id, label)
);

create table if not exists subjects (
  id text primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  name text not null,
  code text not null default ''
);

create table if not exists classes (
  id text primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  name text not null,
  grade integer not null,
  session_label text not null default '',
  room text not null default '',
  subject_ids text[] not null default '{}',
  is_active boolean not null default true
);

create table if not exists students (
  tenant_id text not null references tenants(id) on delete cascade,
  id text not null,
  first_name text not null,
  last_name text not null,
  date_of_birth date not null,
  gender text,
  parent_name text not null,
  parent_phone text not null,
  alt_phone text,
  address text,
  admitted_on date not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (tenant_id, id)
);

create table if not exists enrollments (
  id text primary key,
  tenant_id text not null,
  student_id text not null,
  academic_year_id text not null references academic_years(id),
  class_id text not null references classes(id),
  enrolled_on date not null,
  status text not null check (status in ('active', 'promoted', 'completed', 'withdrawn')),
  promoted_from_id text,
  foreign key (tenant_id, student_id) references students(tenant_id, id) on delete cascade,
  unique (tenant_id, student_id, academic_year_id)
);

create table if not exists fee_plans (
  id text primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  enrollment_id text not null unique references enrollments(id) on delete cascade,
  annual_fee integer not null check (annual_fee > 0),
  installment_count integer not null check (installment_count between 1 and 36),
  frequency text not null,
  first_due_date date not null,
  note text
);

create table if not exists payments (
  id text primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  enrollment_id text not null references enrollments(id) on delete cascade,
  amount integer not null check (amount > 0),
  date date not null,
  method text not null,
  reference text,
  note text,
  recorded_by text not null,
  created_at timestamptz not null default now()
);

create table if not exists attendance_sessions (
  id text primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  class_id text not null references classes(id),
  academic_year_id text not null references academic_years(id),
  date date not null,
  records jsonb not null,
  marked_by text not null,
  marked_at timestamptz not null default now(),
  audit jsonb not null default '[]',
  unique (tenant_id, class_id, date)
);

create table if not exists exams (
  id text primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  name text not null,
  academic_year_id text not null references academic_years(id),
  class_id text not null references classes(id),
  date date not null,
  subjects jsonb not null,
  description text not null default '',
  created_by text not null,
  is_draft boolean not null default false,
  results_published boolean not null default false,
  published_at timestamptz,
  revision integer not null default 0,
  correction_log jsonb not null default '[]',
  marks jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table if not exists message_batches (
  id text primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  source_key text not null,
  title text not null,
  category text not null,
  class_ids text[] not null default '{}',
  created_by text not null,
  created_at timestamptz not null default now(),
  preview_body text not null default '',
  unique (tenant_id, source_key)
);

create table if not exists message_recipients (
  id text primary key,
  tenant_id text not null,
  batch_id text not null references message_batches(id) on delete cascade,
  position integer not null,
  student_id text,
  student_name text not null,
  parent_name text not null,
  phone text not null,
  body text not null,
  status text not null default 'queued',
  attempts integer not null default 0,
  failure_reason text,
  updated_at timestamptz not null default now()
);
create index if not exists message_recipients_batch on message_recipients (batch_id);

create table if not exists notifications (
  id text primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  type text not null,
  title text not null,
  body text not null,
  admin_only boolean not null default false,
  is_read boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists activity (
  id text primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  type text not null,
  title text not null,
  subtitle text not null default '',
  admin_only boolean not null default false,
  at timestamptz not null default now()
);
create index if not exists activity_tenant_at on activity (tenant_id, at desc);
`;

export async function migrate(db) {
  await db.query(SCHEMA);
}
