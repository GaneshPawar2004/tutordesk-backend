import { Router } from 'express';

import { COLS, currentYear, subjects } from '../data/repo.js';
import { canAccessClass, canSendMessages } from '../services/access.js';

/**
 * GET /api/sync — everything the signed-in user is allowed to see, in one
 * response. The mobile app loads this after login and after each change.
 *
 * Staff get only their assigned classes' students, attendance and exams, no
 * fee data at all, and no fee-reminder batches. Suitable for small/medium
 * tuitions; larger tenants should move to paginated endpoints.
 */
export function syncRoutes(db) {
  const r = Router();

  r.get('/sync', async (req, res) => {
    const t = req.tenantId;
    const u = req.user;
    const admin = u.role === 'admin';
    const [tuition, adminUser, staff, years, classes, subs, year] = await Promise.all([
      db.one('select id, name, city, address, phone, email, sms from tenants where id = $1', [t]),
      db.one(`select id, name, coalesce(email, '') email, phone from users where tenant_id = $1 and role = 'admin' order by created_at limit 1`, [t]),
      db.query(`select ${COLS.staff}, ${admin ? 'invite_code' : 'null'} "inviteCode" from users where tenant_id = $1 and role = 'staff' order by name`, [t]),
      db.query(`select ${COLS.year} from academic_years where tenant_id = $1 order by start_date desc`, [t]),
      db.query(`select ${COLS.class} from classes where tenant_id = $1 order by grade, name`, [t]),
      subjects(db, t),
      currentYear(db, t),
    ]);
    const visibleClassIds = classes.map((c) => c.id).filter((id) => canAccessClass(u, id));

    const enrollments = (await db.query(`select ${COLS.enrollment} from enrollments where tenant_id = $1`, [t]))
      .filter((e) => admin || visibleClassIds.includes(e.classId));
    const studentIds = [...new Set(enrollments.map((e) => e.studentId))];
    const students = studentIds.length
      ? await db.query(`select ${COLS.student} from students where tenant_id = $1 and id = any($2) order by first_name, last_name`, [t, studentIds])
      : [];
    const sessions = await db.query(
      `select ${COLS.session} from attendance_sessions where tenant_id = $1 and class_id = any($2) and academic_year_id = $3 order by date desc`,
      [t, visibleClassIds, year.id],
    );
    const exams = (await db.query(`select ${COLS.exam} from exams where tenant_id = $1 order by date desc`, [t]))
      .filter((e) => visibleClassIds.includes(e.classId));
    const batches = (await db.query(`select ${COLS.batch} from message_batches where tenant_id = $1 order by created_at desc limit 50`, [t]))
      .filter((b) => admin || (b.category !== 'feeReminder' && b.classIds.some((c) => visibleClassIds.includes(c))));
    const recipients = batches.length
      ? await db.query(`select batch_id, ${COLS.recipient} from message_recipients where batch_id = any($1) order by position`, [batches.map((b) => b.id)])
      : [];
    const [notifications, activity] = await Promise.all([
      db.query(`select ${COLS.notification} from notifications where tenant_id = $1 and ($2 or not admin_only) order by created_at desc limit 100`, [t, admin]),
      db.query(`select ${COLS.activity} from activity where tenant_id = $1 and ($2 or not admin_only) order by at desc limit 30`, [t, admin]),
    ]);

    const body = {
      serverTime: new Date().toISOString(),
      me: {
        id: u.id, role: u.role, name: u.name, email: u.email, phone: u.phone, designation: u.designation,
        canSendMessages: canSendMessages(u),
      },
      tuition: { id: tuition.id, name: tuition.name, city: tuition.city, address: tuition.address, phone: tuition.phone, email: tuition.email },
      admin: adminUser,
      staff,
      years,
      classes,
      subjects: subs,
      students,
      enrollments,
      sessions,
      exams,
      batches: batches.map(({ ...b }) => ({ ...b, recipients: recipients.filter((x) => x.batch_id === b.id).map(({ batch_id: _b, ...x }) => x) })),
      notifications,
      activity,
      sms: { ...tuition.sms, simulated: tuition.sms.mode !== 'device' },
      feePlans: [],
      payments: [],
    };
    // Financial data is only ever included for the admin.
    if (admin) {
      body.feePlans = await db.query(`select ${COLS.feePlan} from fee_plans where tenant_id = $1`, [t]);
      body.payments = await db.query(`select ${COLS.payment} from payments where tenant_id = $1 order by date desc, created_at desc`, [t]);
    }
    res.json(body);
  });

  return r;
}
