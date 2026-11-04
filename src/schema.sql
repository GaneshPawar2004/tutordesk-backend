-- Kaksha database schema. Runs on every start; every statement is idempotent.

create or replace function touch_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

-- One teacher's organisation. Every other row belongs to an institute.
create table if not exists institutes (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  owner_id uuid,
  trial_ends_at timestamptz not null,
  staff_login_limit integer not null default 0 check (staff_login_limit >= 0),
  referred_by_mobile text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Owner (admin) or staff login.
create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  institute_id uuid not null references institutes (id) on delete cascade,
  role text not null check (role in ('owner', 'staff')),
  name text not null,
  email text not null,
  mobile text, -- owner's login mobile (unique when set)
  password_hash text not null,
  email_verified boolean not null default false,
  token_version integer not null default 0, -- bumped on password reset so older tokens stop working
  subject text not null default '',
  phone text not null default '',
  salary double precision check (salary >= 0),
  can_access_fees boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint users_email_key unique (email)
);
create unique index if not exists users_mobile_key on users (mobile) where mobile <> '';
create index if not exists users_institute_idx on users (institute_id);

do $$ begin
  alter table institutes add constraint institutes_owner_fk
    foreign key (owner_id) references users (id) on delete set null;
exception when duplicate_object then null;
end $$;

-- One pending email OTP per (email, purpose).
create table if not exists otps (
  email text not null,
  purpose text not null check (purpose in ('signup', 'reset')),
  code_hash text not null,
  attempts integer not null default 0,
  sent_at timestamptz not null default now(),
  expires_at timestamptz not null,
  primary key (email, purpose)
);

create table if not exists classes (
  id uuid primary key default gen_random_uuid(),
  institute_id uuid not null references institutes (id) on delete cascade,
  name text not null,
  name_key text not null, -- lowercase name for uniqueness
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint classes_name_key unique (institute_id, name_key)
);

create table if not exists students (
  id uuid primary key default gen_random_uuid(),
  institute_id uuid not null references institutes (id) on delete cascade,
  class_id uuid not null references classes (id) on delete cascade,
  name text not null,
  father_name text not null default '',
  contact text not null default '',
  parent_mobile text not null default '',
  roll_no text not null default '',
  email text not null default '',
  date_of_birth timestamptz,
  total_fees double precision not null default 0 check (total_fees >= 0),
  fees_paid double precision not null default 0 check (fees_paid >= 0),
  fees_due_date timestamptz,
  disabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- Roll numbers are unique within a class (when given).
create unique index if not exists students_roll_key on students (class_id, roll_no) where roll_no <> '';
create index if not exists students_institute_idx on students (institute_id);
create index if not exists students_class_idx on students (class_id);

-- Attendance of one class on one day.
create table if not exists attendance (
  id uuid primary key default gen_random_uuid(),
  institute_id uuid not null references institutes (id) on delete cascade,
  class_id uuid not null references classes (id) on delete cascade,
  date text not null check (date ~ '^\d{4}-\d{2}-\d{2}$'), -- YYYY-MM-DD
  marked_by uuid references users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint attendance_class_date_key unique (class_id, date)
);
create index if not exists attendance_institute_date_idx on attendance (institute_id, date);

create table if not exists attendance_records (
  attendance_id uuid not null references attendance (id) on delete cascade,
  student_id uuid not null references students (id) on delete cascade,
  position integer not null,
  status text not null check (status in ('present', 'absent', 'leave', 'others')),
  primary key (attendance_id, student_id)
);
create index if not exists attendance_records_student_idx on attendance_records (student_id);

-- A class test; per-student marks live in test_marks.
create table if not exists tests (
  id uuid primary key default gen_random_uuid(),
  institute_id uuid not null references institutes (id) on delete cascade,
  class_id uuid not null references classes (id) on delete cascade,
  subject text not null,
  max_marks double precision not null check (max_marks > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists tests_class_idx on tests (class_id);

create table if not exists test_marks (
  test_id uuid not null references tests (id) on delete cascade,
  student_id uuid not null references students (id) on delete cascade,
  position integer not null,
  marks double precision check (marks >= 0), -- null = absent
  remarks text not null default '',
  skip boolean not null default false,
  primary key (test_id, student_id)
);
create index if not exists test_marks_student_idx on test_marks (student_id);

create table if not exists fee_payments (
  id uuid primary key default gen_random_uuid(),
  institute_id uuid not null references institutes (id) on delete cascade,
  student_id uuid not null references students (id) on delete cascade,
  amount double precision not null check (amount > 0),
  note text not null default '',
  collected_by uuid references users (id) on delete set null,
  paid_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists fee_payments_student_idx on fee_payments (student_id);

create or replace trigger institutes_touch before update on institutes
  for each row execute function touch_updated_at();
create or replace trigger users_touch before update on users
  for each row execute function touch_updated_at();
create or replace trigger classes_touch before update on classes
  for each row execute function touch_updated_at();
create or replace trigger students_touch before update on students
  for each row execute function touch_updated_at();
create or replace trigger attendance_touch before update on attendance
  for each row execute function touch_updated_at();
create or replace trigger tests_touch before update on tests
  for each row execute function touch_updated_at();
create or replace trigger fee_payments_touch before update on fee_payments
  for each row execute function touch_updated_at();

-- ---- Access control (set from the admin page) ---------------------------------
-- trial: allowed until trial_ends_at; active: allowed until access_until (null = no end);
-- blocked: no access. Applies to the owner and all staff of the institute.
alter table institutes add column if not exists access_status text not null default 'trial';
alter table institutes add column if not exists access_until timestamptz;
do $$ begin
  alter table institutes add constraint institutes_access_status_check
    check (access_status in ('trial', 'active', 'blocked'));
exception when duplicate_object then null;
end $$;

-- ---- Student photos -------------------------------------------------------------
alter table students add column if not exists photo_updated_at timestamptz;

create table if not exists student_photos (
  student_id uuid primary key references students (id) on delete cascade,
  mime text not null,
  image bytea not null
);

-- ---- Parent SMS queue -----------------------------------------------------------
-- Every SMS the app sends from a teacher's SIM is recorded here first, so the admin
-- and staff see what is still unsent (e.g. a phone hit its daily SMS limit) and any
-- of them can send the rest from their own phone. A "batch" is one SEND TO ALL list.
create table if not exists sms_batches (
  id uuid primary key default gen_random_uuid(),
  institute_id uuid not null references institutes (id) on delete cascade,
  class_id uuid references classes (id) on delete set null,
  kind text not null default 'other', -- absent | fees | marks | birthday | receipt | other
  title text not null,
  created_by uuid references users (id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists sms_batches_institute_idx on sms_batches (institute_id, created_at);

create table if not exists sms_messages (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references sms_batches (id) on delete cascade,
  student_id uuid references students (id) on delete set null,
  position integer not null,
  name text not null,
  phone text not null,
  body text not null,
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed', 'dismissed')),
  reason text,
  channel text, -- sms | whatsapp | sms_app
  claimed_by uuid references users (id) on delete set null,
  claimed_until timestamptz,
  sent_by uuid references users (id) on delete set null,
  sent_at timestamptz
);
create index if not exists sms_messages_batch_idx on sms_messages (batch_id, status);
