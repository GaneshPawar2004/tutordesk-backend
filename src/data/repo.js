import { randomUUID } from 'node:crypto';

/** Column lists that map snake_case rows to the camelCase API shape. */
export const COLS = {
  student: `id, first_name "firstName", last_name "lastName", date_of_birth "dateOfBirth", gender,
    parent_name "parentName", parent_phone "parentPhone", alt_phone "altPhone", address,
    admitted_on "admittedOn", is_active "isActive"`,
  enrollment: `id, student_id "studentId", academic_year_id "academicYearId", class_id "classId",
    enrolled_on "enrolledOn", status, promoted_from_id "promotedFromId"`,
  year: `id, label, start_date "startDate", end_date "endDate", status`,
  class: `id, name, grade, session_label "sessionLabel", room, subject_ids "subjectIds", is_active "isActive"`,
  staff: `id, name, phone, coalesce(email, '') email, designation, assigned_class_ids "assignedClassIds",
    permissions, joined_on "joinedOn", is_active "isActive", account_status "accountStatus"`,
  feePlan: `id, enrollment_id "enrollmentId", annual_fee "annualFee", installment_count "installmentCount",
    frequency, first_due_date "firstDueDate", note`,
  payment: `id, enrollment_id "enrollmentId", amount, date, method, reference, note, recorded_by "recordedBy"`,
  session: `id, class_id "classId", academic_year_id "academicYearId", date, records, marked_by "markedBy",
    marked_at "markedAt", audit`,
  exam: `id, name, academic_year_id "academicYearId", class_id "classId", date, subjects, description,
    created_by "createdBy", is_draft "isDraft", results_published "resultsPublished", published_at "publishedAt",
    revision, correction_log "correctionLog", marks`,
  batch: `id, source_key "sourceKey", title, category, class_ids "classIds", created_by "createdBy",
    created_at "createdAt", preview_body "previewBody"`,
  recipient: `id, student_id "studentId", student_name "studentName", parent_name "parentName", phone, body,
    status, attempts, failure_reason "failureReason", updated_at "updatedAt"`,
  notification: `id, type, title, body, created_at "createdAt", is_read "isRead", admin_only "adminOnly"`,
  activity: `type, title, subtitle, at, admin_only "adminOnly"`,
};

export const newId = () => randomUUID();
export const fullName = (s) => `${s.firstName} ${s.lastName}`;

export async function currentYear(db, tenantId) {
  return (
    (await db.one(`select ${COLS.year} from academic_years where tenant_id = $1 and status = 'active' limit 1`, [tenantId])) ??
    (await db.one(`select ${COLS.year} from academic_years where tenant_id = $1 order by start_date desc limit 1`, [tenantId]))
  );
}

/** Active students enrolled (not withdrawn) in a class for a year, sorted by name. */
export function roster(db, tenantId, classId, yearId) {
  return db.query(
    `select ${COLS.student.replace(/(^|,\s*)(\w+)/g, '$1s.$2')}, e.id "enrollmentId"
       from enrollments e join students s on s.tenant_id = e.tenant_id and s.id = e.student_id
      where e.tenant_id = $1 and e.class_id = $2 and e.academic_year_id = $3
        and e.status <> 'withdrawn' and s.is_active
      order by s.first_name, s.last_name`,
    [tenantId, classId, yearId],
  );
}

/** Fee plans + payments for the given enrollments, in the shape services/fees.js expects. */
export async function feeContext(db, tenantId, enrollmentIds) {
  if (!enrollmentIds.length) return { feePlans: [], payments: [] };
  const [feePlans, payments] = await Promise.all([
    db.query(`select ${COLS.feePlan} from fee_plans where tenant_id = $1 and enrollment_id = any($2)`, [tenantId, enrollmentIds]),
    db.query(`select ${COLS.payment} from payments where tenant_id = $1 and enrollment_id = any($2) order by date desc, created_at desc`, [tenantId, enrollmentIds]),
  ]);
  return { feePlans, payments };
}

export function subjects(db, tenantId) {
  return db.query('select id, name, code from subjects where tenant_id = $1 order by name', [tenantId]);
}

export function logActivity(db, tenantId, { type, title, subtitle = '', adminOnly = false }) {
  return db.query(
    'insert into activity (id, tenant_id, type, title, subtitle, admin_only) values ($1, $2, $3, $4, $5, $6)',
    [newId(), tenantId, type, title, subtitle, adminOnly],
  );
}

export function notify(db, tenantId, { type, title, body, adminOnly = false }) {
  return db.query(
    'insert into notifications (id, tenant_id, type, title, body, admin_only) values ($1, $2, $3, $4, $5, $6)',
    [newId(), tenantId, type, title, body, adminOnly],
  );
}

/** Today's date (YYYY-MM-DD) in the server's local time zone. */
export function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
