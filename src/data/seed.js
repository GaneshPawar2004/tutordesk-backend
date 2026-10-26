import { addDays, isoDate, mulberry32, parseDate } from '../lib/util.js';
import { buildSchedule } from '../services/fees.js';
import { resultFor } from '../services/results.js';
import { attendanceMessage, examResultMessage, feeReminderMessage, announcementMessage } from '../services/templates.js';

/**
 * Builds one tenant's demo data. Deterministic, fictional, and internally
 * consistent with the mobile app's seed (same people, classes and rules).
 */
export function buildSeed(now = new Date()) {
  const rnd = mulberry32(2026);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const today = isoDate(now);
  const todayDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const at = (minutesAgo) => new Date(now.getTime() - minutesAgo * 60000).toISOString();
  const CURRENT = 'ay-2026';

  const tuition = {
    id: 'tui-1',
    name: 'Bright Future Classes',
    city: 'Nashik',
    address: '2nd Floor, Sai Plaza, College Road, Nashik 422005',
    phone: '9822041567',
    email: 'hello@brightfutureclasses.in',
  };
  const admin = { id: 'adm-1', name: 'Rahul Sharma', email: 'rahul@brightfutureclasses.in', phone: '9822041567' };

  const years = [
    { id: 'ay-2024', label: '2024–25', startDate: '2024-06-01', endDate: '2025-04-30', status: 'closed' },
    { id: 'ay-2025', label: '2025–26', startDate: '2025-06-01', endDate: '2026-04-30', status: 'closed' },
    { id: CURRENT, label: '2026–27', startDate: '2026-06-01', endDate: '2027-04-30', status: 'active' },
    { id: 'ay-2027', label: '2027–28', startDate: '2027-06-01', endDate: '2028-04-30', status: 'upcoming' },
  ];
  const subjects = [
    { id: 'sub-math', name: 'Mathematics', code: 'MATH' },
    { id: 'sub-sci', name: 'Science', code: 'SCI' },
    { id: 'sub-eng', name: 'English', code: 'ENG' },
    { id: 'sub-ss', name: 'Social Studies', code: 'SST' },
    { id: 'sub-hin', name: 'Hindi', code: 'HIN' },
    { id: 'sub-mar', name: 'Marathi', code: 'MAR' },
  ];
  const junior = ['sub-math', 'sub-sci', 'sub-eng'];
  const senior = [...junior, 'sub-ss'];
  const classes = [
    { id: 'cls-4', name: 'Class 4', grade: 4, sessionLabel: '4:00 – 5:00 PM', room: 'Room 1', subjectIds: junior, isActive: false },
    { id: 'cls-5', name: 'Class 5', grade: 5, sessionLabel: '4:00 – 5:00 PM', room: 'Room 1', subjectIds: junior, isActive: true },
    { id: 'cls-6', name: 'Class 6', grade: 6, sessionLabel: '5:00 – 6:00 PM', room: 'Room 1', subjectIds: junior, isActive: true },
    { id: 'cls-7', name: 'Class 7', grade: 7, sessionLabel: '6:00 – 7:00 PM', room: 'Room 2', subjectIds: junior, isActive: true },
    { id: 'cls-8', name: 'Class 8', grade: 8, sessionLabel: '7:00 – 8:00 AM', room: 'Room 2', subjectIds: senior, isActive: true },
    { id: 'cls-9', name: 'Class 9', grade: 9, sessionLabel: '8:00 – 9:30 AM', room: 'Room 3', subjectIds: senior, isActive: true },
    { id: 'cls-10', name: 'Class 10', grade: 10, sessionLabel: '6:00 – 7:30 PM', room: 'Room 3', subjectIds: senior, isActive: true },
  ];

  const P = {
    view: 'viewStudents', mark: 'markAttendance', results: 'viewExamResults', marks: 'enterMarks',
    msg: 'sendParentMessages', sms: 'sendSms', edit: 'editStudents',
  };
  const staff = [
    { id: 'stf-1', name: 'Sneha Kulkarni', phone: '9881234570', email: 'sneha.k@brightfutureclasses.in', designation: 'Mathematics teacher', assignedClassIds: ['cls-5', 'cls-6', 'cls-7'], permissions: [P.view, P.mark, P.results, P.marks, P.msg, P.sms], joinedOn: '2023-06-05', isActive: true, accountStatus: 'active' },
    { id: 'stf-2', name: 'Amit Deshmukh', phone: '9762045318', email: 'amit.d@brightfutureclasses.in', designation: 'Science teacher', assignedClassIds: ['cls-8', 'cls-9', 'cls-10'], permissions: [P.view, P.mark, P.results, P.marks], joinedOn: '2024-06-03', isActive: true, accountStatus: 'active' },
    { id: 'stf-3', name: 'Pooja Joshi', phone: '8805512946', email: 'pooja.j@brightfutureclasses.in', designation: 'English teacher', assignedClassIds: ['cls-5', 'cls-8'], permissions: [P.view, P.mark, P.results, P.marks, P.msg], joinedOn: '2025-07-01', isActive: true, accountStatus: 'active' },
    { id: 'stf-4', name: 'Vikram Patil', phone: '9423087651', email: 'vikram.p@brightfutureclasses.in', designation: 'Social studies teacher', assignedClassIds: ['cls-9', 'cls-10'], permissions: [P.view, P.mark], joinedOn: '2025-06-09', isActive: true, accountStatus: 'active' },
    { id: 'stf-5', name: 'Neha Gaikwad', phone: '7798456120', email: 'neha.g@brightfutureclasses.in', designation: 'Front desk coordinator', assignedClassIds: ['cls-5', 'cls-6', 'cls-7', 'cls-8', 'cls-9', 'cls-10'], permissions: [P.view, P.edit, P.msg, P.sms], joinedOn: today, isActive: true, accountStatus: 'invitationPending' },
  ];

  // ----------------------------------------------------------- students
  const boys = ['Vihaan', 'Arjun', 'Sai', 'Reyansh', 'Ayaan', 'Krishna', 'Ishaan', 'Shaurya', 'Atharv', 'Advait', 'Om', 'Rudra', 'Kabir', 'Aditya', 'Yash', 'Pranav', 'Siddharth', 'Tanmay', 'Omkar', 'Soham', 'Harsh', 'Rohan', 'Varun', 'Nikhil', 'Aryan', 'Dhruv', 'Parth', 'Vedant', 'Mihir', 'Kunal'];
  const girls = ['Ananya', 'Diya', 'Saanvi', 'Aadhya', 'Ira', 'Myra', 'Anvi', 'Riya', 'Kavya', 'Isha', 'Sanika', 'Gauri', 'Mrunal', 'Shravani', 'Tanvi', 'Rutuja', 'Sakshi', 'Aditi', 'Janhavi', 'Siya', 'Prachi', 'Vaishnavi', 'Swara', 'Avni', 'Khushi', 'Nidhi', 'Ketaki', 'Mansi', 'Shruti', 'Tejal'];
  const surnames = ['Patil', 'Pawar', 'Jadhav', 'Shinde', 'Deshmukh', 'Kulkarni', 'Joshi', 'Chavan', 'More', 'Gaikwad', 'Bhosale', 'Kale', 'Wagh', 'Sawant', 'Sharma', 'Mehta', 'Shah', 'Iyer', 'Nair', 'Reddy', 'Gupta', 'Verma', 'Agarwal', 'Thakur', 'Mane', 'Kadam', 'Salunkhe', 'Nikam', 'Sonawane', 'Borse'];
  const fathers = ['Sunil', 'Rajesh', 'Sanjay', 'Mahesh', 'Prakash', 'Anil', 'Vijay', 'Santosh', 'Ramesh', 'Dinesh', 'Nitin', 'Sachin', 'Ajay', 'Manoj', 'Deepak', 'Rahul', 'Amol', 'Yogesh', 'Kiran', 'Sandeep'];
  const mothers = ['Sunita', 'Kavita', 'Meena', 'Swati', 'Asha', 'Vaishali', 'Archana', 'Manisha', 'Rupali', 'Jyoti'];
  const areas = ['Gangapur Road', 'College Road', 'Indira Nagar', 'Panchavati', 'Nashik Road', 'Satpur', 'Cidco', 'Govind Nagar'];
  const baseFee = { 4: 10000, 5: 12000, 6: 13000, 7: 14000, 8: 16000, 9: 18000, 10: 20000 };

  const students = [];
  const enrollments = [];
  const feePlans = [];
  const payments = [];
  const ability = {};
  const reliability = {};
  const used = new Set(['Ganesh Pawar', 'Aarav Sharma', 'Priya Patil']);
  let enr = 0, fee = 0, pay = 0;

  const phoneNo = () => pick(['98', '97', '96', '94', '88', '87', '77', '70']) + Array.from({ length: 8 }, () => Math.floor(rnd() * 10)).join('');
  const randomName = () => {
    for (;;) {
      const female = rnd() < 0.5;
      const first = female ? pick(girls) : pick(boys);
      const last = pick(surnames);
      if (!used.has(`${first} ${last}`)) {
        used.add(`${first} ${last}`);
        return [first, last, female ? 'female' : 'male'];
      }
    }
  };
  const method = () => {
    const r = rnd();
    return r < 0.45 ? 'upi' : r < 0.8 ? 'cash' : r < 0.92 ? 'bankTransfer' : 'cheque';
  };
  const addPayment = (enrollmentId, amount, date, note) => {
    if (amount <= 0) return;
    const m = method();
    payments.push({
      id: `pay-${++pay}`, enrollmentId, amount, date, method: m,
      reference: m === 'cash' ? null : `${m === 'upi' ? 'UPI' : m === 'cheque' ? 'CHQ' : 'NEFT'} ${Math.floor(rnd() * 1e10)}`,
      note: note ?? null, recordedBy: admin.name,
    });
  };

  function feesFor(e, grade, n) {
    const startYear = Number(e.academicYearId.slice(3));
    const isCurrent = e.academicYearId === CURRENT;
    if (n === 1) {
      // Ganesh Pawar — fixed history used across demos and tests.
      if (!isCurrent) {
        const plan = { id: `fee-${++fee}`, enrollmentId: e.id, annualFee: 9000, installmentCount: 3, frequency: 'quarterly', firstDueDate: '2025-06-10', note: null };
        feePlans.push(plan);
        for (const i of buildSchedule(plan)) payments.push({ id: `pay-${++pay}`, enrollmentId: e.id, amount: i.amount, date: i.dueDate, method: 'cash', reference: null, note: null, recordedBy: admin.name });
        return;
      }
      feePlans.push({ id: `fee-${++fee}`, enrollmentId: e.id, annualFee: 12000, installmentCount: 6, frequency: 'monthly', firstDueDate: '2026-06-15', note: null });
      for (const [amount, date, m, note] of [
        [2000, '2026-06-01', 'cash', 'Initial payment at re-enrolment'],
        [2000, '2026-07-12', 'upi', null],
        [2000, '2026-08-14', 'upi', null],
        [2000, '2026-09-16', 'cash', null],
      ]) {
        if (date <= today) payments.push({ id: `pay-${++pay}`, enrollmentId: e.id, amount, date, method: m, reference: null, note, recordedBy: admin.name });
      }
      return;
    }
    let annualFee = baseFee[grade] - 1000 * (2026 - startYear);
    const concession = rnd() < 0.15;
    if (concession) annualFee -= pick([500, 1000, 1500]);
    const count = pick([1, 2, 3, 4, 4, 6, 6, 10, 10, 10]);
    const frequency = count === 2 ? 'halfYearly' : count === 3 || count === 4 ? 'quarterly' : count === 1 ? 'custom' : 'monthly';
    const yearStart = `${startYear}-06-10`;
    const afterJoin = isoDate(addDays(parseDate(e.enrolledOn), 7));
    const plan = {
      id: `fee-${++fee}`, enrollmentId: e.id, annualFee, installmentCount: count, frequency,
      firstDueDate: afterJoin > yearStart ? afterJoin : yearStart,
      note: concession ? 'Sibling / early-admission concession' : null,
    };
    feePlans.push(plan);
    const schedule = buildSchedule(plan);
    const payBySchedule = (target, latest) => {
      let paid = 0;
      for (const inst of schedule) {
        if (paid >= target) break;
        let d = isoDate(addDays(parseDate(inst.dueDate), -Math.floor(rnd() * 6)));
        if (d < e.enrolledOn) d = e.enrolledOn;
        if (d > latest) d = latest;
        const amount = Math.min(inst.amount, target - paid);
        addPayment(e.id, amount, d);
        paid += amount;
      }
      if (paid < target) addPayment(e.id, target - paid, latest);
    };
    if (!isCurrent) {
      payBySchedule(rnd() < 0.9 ? annualFee : annualFee - pick([1000, 1500, 2000]), `${startYear + 1}-04-30`);
      return;
    }
    if (e.status === 'withdrawn') return payBySchedule(schedule[0].amount, today);
    const r = rnd();
    if (r < 0.32) return addPayment(e.id, annualFee, e.enrolledOn, 'Full annual fee at admission');
    if (r < 0.86) {
      const dueCount = schedule.filter((i) => i.dueDate <= today).length;
      const k = Math.max(1, dueCount - Math.floor(rnd() * 3));
      let target = schedule.slice(0, k).reduce((s, i) => s + i.amount, 0);
      if (rnd() < 0.3) target -= 500;
      if (target >= annualFee) target = annualFee - 1000;
      payBySchedule(target, today);
    }
  }

  function addStudent(n, first, last, gender, cls, active = true) {
    const id = `STU-${String(n).padStart(4, '0')}`;
    const grade = cls.grade;
    let prior = 0;
    if (n === 1) prior = 1;
    else if (grade === 5) prior = rnd() < 0.3 ? 1 : 0;
    else if (rnd() < 0.65) prior = grade >= 7 && rnd() < 0.45 ? 2 : 1;
    const firstEnrolment = prior > 0
      ? `${2026 - prior}-06-${String(1 + Math.floor(rnd() * 20)).padStart(2, '0')}`
      : isoDate(addDays(new Date(2026, 5, 1), Math.floor(rnd() * (n % 9 === 0 ? 100 : 40))));
    const parentFirst = rnd() < 0.25 ? pick(mothers) : pick(fathers);
    students.push({
      id, firstName: first, lastName: last, gender,
      dateOfBirth: isoDate(new Date(2026 - grade - 5 - Math.floor(rnd() * 2), Math.floor(rnd() * 12), 1 + Math.floor(rnd() * 28))),
      parentName: `${parentFirst} ${last}`,
      parentPhone: phoneNo(),
      altPhone: rnd() < 0.35 ? phoneNo() : null,
      address: rnd() < 0.85 ? `Flat ${1 + Math.floor(rnd() * 40)}, ${pick(areas)}, Nashik` : null,
      admittedOn: firstEnrolment,
      isActive: active,
    });
    ability[id] = 0.48 + rnd() * 0.46;
    reliability[id] = 0.8 + rnd() * 0.18;
    let previous = null;
    for (let p = prior; p >= 1; p--) {
      const e = { id: `enr-${++enr}`, studentId: id, academicYearId: `ay-${2026 - p}`, classId: `cls-${grade - p}`, enrolledOn: p === prior ? firstEnrolment : `${2026 - p}-06-01`, status: 'promoted', promotedFromId: previous };
      enrollments.push(e);
      feesFor(e, grade - p, n);
      previous = e.id;
    }
    const current = { id: `enr-${++enr}`, studentId: id, academicYearId: CURRENT, classId: cls.id, enrolledOn: prior > 0 ? '2026-06-01' : firstEnrolment, status: active ? 'active' : 'withdrawn', promotedFromId: previous };
    enrollments.push(current);
    feesFor(current, grade, n);
  }

  const counts = { 'cls-5': 22, 'cls-6': 21, 'cls-7': 23, 'cls-8': 20, 'cls-9': 22, 'cls-10': 20 };
  const fixed = [['Ganesh', 'Pawar', 'male'], ['Aarav', 'Sharma', 'male'], ['Priya', 'Patil', 'female']];
  let n = 0;
  for (const [classId, count] of Object.entries(counts)) {
    const cls = classes.find((c) => c.id === classId);
    for (let i = 0; i < count; i++) {
      n++;
      const [f, l, g] = n <= fixed.length ? fixed[n - 1] : randomName();
      addStudent(n, f, l, g, cls);
    }
  }
  for (const classId of ['cls-6', 'cls-7', 'cls-9']) {
    n++;
    const [f, l, g] = randomName();
    addStudent(n, f, l, g, classes.find((c) => c.id === classId), false);
  }

  const activeIn = (classId, on) => {
    const ids = new Set(
      enrollments
        .filter((e) => e.academicYearId === CURRENT && e.classId === classId && e.status === 'active' && (!on || e.enrolledOn <= on))
        .map((e) => e.studentId),
    );
    return students.filter((s) => ids.has(s.id));
  };
  const markerFor = (classId) => staff.find((s) => s.assignedClassIds.includes(classId) && s.accountStatus === 'active').name;
  const roll = (id) => {
    if (rnd() < reliability[id]) return rnd() < 0.05 ? 'late' : 'present';
    return rnd() < 0.25 ? 'leave' : 'absent';
  };

  // --------------------------------------------------------- attendance
  const sessions = [];
  const running = classes.filter((c) => c.isActive);
  for (let offset = 30; offset >= 1; offset--) {
    const d = addDays(todayDate, -offset);
    const date = isoDate(d);
    if (d.getDay() === 0 || date < '2026-06-01') continue;
    for (const c of running) {
      const roster = activeIn(c.id, date);
      if (!roster.length) continue;
      sessions.push({
        id: `att-${c.id}-${date.replaceAll('-', '')}`, classId: c.id, academicYearId: CURRENT, date,
        records: Object.fromEntries(roster.map((s) => [s.id, roll(s.id)])),
        markedBy: markerFor(c.id), markedAt: new Date(d.getTime() + (9 + c.grade) * 3600000).toISOString(), audit: [],
      });
    }
  }
  ['cls-8', 'cls-9', 'cls-5', 'cls-6'].forEach((classId, i) => {
    sessions.push({
      id: `att-${classId}-${today.replaceAll('-', '')}`, classId, academicYearId: CURRENT, date: today,
      records: Object.fromEntries(activeIn(classId).map((s) => [s.id, s.id === 'STU-0001' ? 'present' : roll(s.id)])),
      markedBy: markerFor(classId), markedAt: at(190 - i * 45), audit: [],
    });
  });

  // -------------------------------------------------------------- exams
  const marksFor = (roster, max, { fixedMarks = {}, absent = [], limit } = {}) => {
    const out = {};
    for (const s of limit ? roster.slice(0, limit) : roster) {
      if (absent.includes(s.id)) { out[s.id] = { marks: null, absent: true }; continue; }
      const v = fixedMarks[s.id] ?? Math.round(Math.min(max, Math.max(0, max * (ability[s.id] + (rnd() - 0.5) * 0.18))));
      out[s.id] = { marks: v, absent: false };
    }
    return out;
  };
  const dow = todayDate.getDay();
  const lastSunday = isoDate(addDays(todayDate, -(dow === 0 ? 7 : dow)));
  const sub = (id, max) => ({ subjectId: id, maxMarks: max });
  const c5 = activeIn('cls-5'), c7 = activeIn('cls-7'), c8 = activeIn('cls-8'), c9 = activeIn('cls-9');
  const base = { academicYearId: CURRENT, isDraft: false, resultsPublished: false, publishedAt: null, revision: 0, correctionLog: [], marks: {}, description: '' };
  const exams = [
    { ...base, id: 'exm-1', name: 'Sunday Weekly Test', classId: 'cls-5', date: lastSunday, createdBy: 'Sneha Kulkarni', description: 'Weekly revision test.', subjects: [sub('sub-math', 50), sub('sub-sci', 50), sub('sub-eng', 50)], resultsPublished: true, publishedAt: new Date(addDays(parseDate(lastSunday), 1).getTime() + 18.5 * 3600000).toISOString(),
      marks: {
        'sub-math': marksFor(c5, 50, { fixedMarks: { 'STU-0001': 42, 'STU-0002': 36, 'STU-0003': 45 } }),
        'sub-sci': marksFor(c5, 50, { fixedMarks: { 'STU-0001': 44 } }),
        'sub-eng': marksFor(c5, 50, { fixedMarks: { 'STU-0001': 40 }, absent: [c5[7].id] }),
      } },
    { ...base, id: 'exm-2', name: 'Unit Test 2', classId: 'cls-8', date: isoDate(addDays(todayDate, -5)), createdBy: 'Amit Deshmukh', subjects: [sub('sub-math', 25)], marks: { 'sub-math': marksFor(c8, 25, { limit: 12, absent: [c8[3].id] }) } },
    { ...base, id: 'exm-3', name: 'Mid-term Examination', classId: 'cls-10', date: isoDate(addDays(todayDate, 6)), createdBy: admin.name, subjects: [sub('sub-math', 80), sub('sub-sci', 80), sub('sub-eng', 80), sub('sub-ss', 80)] },
    { ...base, id: 'exm-4', name: 'Chapter Test: Algebra', classId: 'cls-9', date: isoDate(addDays(todayDate, 3)), createdBy: 'Amit Deshmukh', subjects: [sub('sub-math', 40)] },
    { ...base, id: 'exm-5', name: 'Grammar Quiz', classId: 'cls-6', date: isoDate(addDays(todayDate, 10)), createdBy: 'Pooja Joshi', isDraft: true, subjects: [sub('sub-eng', 20)] },
    { ...base, id: 'exm-6', name: 'Monthly Test — September', classId: 'cls-7', date: '2026-09-27', createdBy: 'Sneha Kulkarni', subjects: [sub('sub-math', 100), sub('sub-sci', 100)], resultsPublished: true, publishedAt: '2026-09-30T19:00:00.000Z',
      marks: { 'sub-math': marksFor(c7, 100), 'sub-sci': marksFor(c7, 100, { absent: [c7[11].id] }) } },
    { ...base, id: 'exm-7', name: 'Mathematics Weekly Quiz', classId: 'cls-9', date: isoDate(addDays(todayDate, -2)), createdBy: 'Amit Deshmukh', subjects: [sub('sub-math', 30)], resultsPublished: true, publishedAt: at(140), marks: { 'sub-math': marksFor(c9, 30) } },
  ];

  // ------------------------------------------------------------ messages
  const t = { tuition, subjects };
  const status = (i, failed = [], pending = []) => (failed.includes(i) ? 'failed' : pending.includes(i) ? 'queued' : i % 3 === 2 ? 'sent' : 'delivered');
  const recipient = (batchNo, i, s, body, st, extra = {}) => ({
    id: `rcp-${batchNo}-${i}`, studentId: s.id, studentName: `${s.firstName} ${s.lastName}`, parentName: s.parentName,
    phone: s.parentPhone, body, status: st, attempts: st === 'queued' ? 0 : 1, failureReason: null, updatedAt: at(30), ...extra,
  });
  const e1 = exams[0];
  const s8 = sessions.find((s) => s.id === `att-cls-8-${today.replaceAll('-', '')}`);
  const allActive = students.filter((s) => s.isActive);
  const ann = { title: 'Diwali holidays', body: 'Classes will remain closed from 7 to 10 November for Diwali. Regular batches resume on Wednesday, 11 November.' };
  const overdueStudents = [];
  for (const s of allActive) {
    const e = enrollments.find((x) => x.studentId === s.id && x.academicYearId === CURRENT);
    const plan = feePlans.find((p) => p.enrollmentId === e.id);
    const paid = payments.filter((p) => p.enrollmentId === e.id).reduce((a, p) => a + p.amount, 0);
    const due = buildSchedule(plan).filter((i) => i.dueDate < today).reduce((a, i) => a + i.amount, 0) - paid;
    if (due > 0) overdueStudents.push([s, due]);
    if (overdueStudents.length === 14) break;
  }
  const batches = [
    {
      id: 'bat-1', sourceKey: 'exam:exm-1:r0', title: `${e1.name} results`, category: 'examResults', classIds: ['cls-5'], createdBy: 'Sneha Kulkarni', createdAt: e1.publishedAt,
      previewBody: examResultMessage(e1.name, 'Ganesh Pawar', resultFor(t, e1, 'STU-0001'), tuition.name),
      recipients: c5.map((s, i) => recipient(1, i, s, examResultMessage(e1.name, `${s.firstName} ${s.lastName}`, resultFor(t, e1, s.id), tuition.name), status(i, [9]), i === 9 ? { failureReason: 'Number unreachable' } : {})),
    },
    {
      id: 'bat-2', sourceKey: `attendance:${s8.id}`, title: 'Class 8 attendance · today', category: 'attendance', classIds: ['cls-8'], createdBy: 'Amit Deshmukh', createdAt: at(185),
      previewBody: attendanceMessage('absent', '[Student Name]', tuition.name),
      recipients: c8.map((s, i) => recipient(2, i, s, attendanceMessage(s8.records[s.id], `${s.firstName} ${s.lastName}`, tuition.name), status(i, [4, 13]), [4, 13].includes(i) ? { failureReason: 'Device reported send failure' } : {})),
    },
    {
      id: 'bat-3', sourceKey: 'announcement:ann-seed-1', title: ann.title, category: 'announcement', classIds: running.map((c) => c.id), createdBy: admin.name, createdAt: at(2 * 24 * 60 + 180),
      previewBody: announcementMessage(ann.title, ann.body, tuition.name),
      recipients: allActive.map((s, i) => recipient(3, i, s, announcementMessage(ann.title, ann.body, tuition.name), status(i))),
    },
    {
      id: 'bat-4', sourceKey: 'fees:reminder:seed', title: 'Fee reminder · this month', category: 'feeReminder', classIds: running.map((c) => c.id), createdBy: admin.name, createdAt: at(23 * 60),
      previewBody: feeReminderMessage('[Student Name]', 2000, tuition.name),
      recipients: overdueStudents.map(([s, due], i) => recipient(4, i, s, feeReminderMessage(`${s.firstName} ${s.lastName}`, due, tuition.name), status(i, [2, 8], [11, 12, 13]), [2, 8].includes(i) ? { failureReason: 'SIM not available' } : {})),
    },
  ];

  const notifications = [
    { id: 'ntf-1', type: 'messageFailed', title: '2 attendance alerts failed', body: 'Class 8 · Retry the failed messages from the batch.', createdAt: at(38), isRead: false, adminOnly: false },
    { id: 'ntf-2', type: 'attendance', title: 'Attendance marked for Class 6', body: 'Sneha Kulkarni saved today\'s session.', createdAt: at(55), isRead: false, adminOnly: false },
    { id: 'ntf-3', type: 'exam', title: 'Results published: Mathematics Weekly Quiz', body: 'Class 9 results are ready to share with parents.', createdAt: at(140), isRead: false, adminOnly: false },
    { id: 'ntf-4', type: 'staff', title: 'Invitation pending for Neha Gaikwad', body: 'Account setup is waiting for the staff member to accept.', createdAt: at(240), isRead: false, adminOnly: true },
    { id: 'ntf-5', type: 'messageFailed', title: 'Fee reminders waiting to send', body: '3 pending and 2 failed in yesterday\'s reminder batch.', createdAt: at(1200), isRead: true, adminOnly: true },
  ];
  const activity = [
    { type: 'attendance', title: 'Attendance marked for Class 5', subtitle: `Sneha Kulkarni · ${c5.length} students`, at: at(55), adminOnly: false },
    { type: 'exam', title: 'Mathematics results published', subtitle: 'Mathematics Weekly Quiz · Class 9', at: at(140), adminOnly: false },
    { type: 'staff', title: 'Staff member added', subtitle: 'Neha Gaikwad · Front desk coordinator', at: at(240), adminOnly: true },
  ];
  const events = [
    { title: 'Parent–teacher meeting', date: isoDate(addDays(todayDate, 4)), subtitle: 'Classes 9 & 10 · 11:00 AM, Room 3' },
    { title: 'Diwali holidays', date: '2026-11-07', endDate: '2026-11-10', subtitle: 'All batches closed' },
  ];
  const sms = { mode: 'androidDevice', deviceName: 'Redmi Note 12 · Front desk', lastSync: at(12), monthlyAllowance: 3000, usedThisMonth: 1264, isMock: true };

  return {
    tuition, admin, staff, years, classes, subjects, students, enrollments, feePlans, payments,
    sessions, exams, batches, notifications, activity, events, sms,
    counters: { student: n, enrollment: 10000, fee: 10000, payment: 10000, exam: 1000, batch: 1000, notification: 1000, staff: 100, class: 100, year: 100 },
  };
}
