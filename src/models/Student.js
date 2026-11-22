const { todayIST } = require('../utils/scope');

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Months billed so far for a monthly fee starting in [feeStart] ("YYYY-MM"):
 * the start month and every month up to the current one (India time).
 */
function monthsBilled(feeStart, today = todayIST()) {
  const m = /^(\d{4})-(\d{2})/.exec(feeStart || '');
  if (!m) return 0;
  const [ty, tm] = today.split('-').map(Number);
  return Math.max(0, (ty - Number(m[1])) * 12 + (tm - Number(m[2])) + 1);
}

/**
 * What the student owes in total so far: one-time fees (total_fees) plus the
 * monthly fee for every month billed. Students without a monthly fee: total_fees.
 */
const totalDue = (st, today) =>
  round2(st.total_fees + (st.monthly_fee > 0 ? st.monthly_fee * monthsBilled(st.fee_start, today) : 0));

const feesDue = (st, today) => Math.max(0, round2(totalDue(st, today) - st.fees_paid));

/** `students` row -> API object; fee fields only when [withFees]. */
function toPublic(st, withFees = true) {
  const out = {
    id: st.id,
    class: st.class_id,
    name: st.name,
    fatherName: st.father_name,
    contact: st.contact,
    parentMobile: st.parent_mobile,
    rollNo: st.roll_no,
    email: st.email,
    dateOfBirth: st.date_of_birth,
    disabled: st.disabled,
    // Changes whenever the photo changes (null = no photo); fetch GET /students/:id/photo.
    photoUpdatedAt: st.photo_updated_at ?? null,
    createdAt: st.created_at,
  };
  if (withFees) {
    Object.assign(out, {
      // Everything billed so far (one-time + months); `oneTimeFees` is the stored part.
      totalFees: totalDue(st),
      oneTimeFees: st.total_fees,
      monthlyFee: st.monthly_fee ?? 0,
      feeStart: st.fee_start ?? null,
      monthsBilled: st.monthly_fee > 0 ? monthsBilled(st.fee_start) : 0,
      feesPaid: st.fees_paid,
      feesDue: feesDue(st),
      feesDueDate: st.fees_due_date,
    });
  }
  return out;
}

/**
 * API field -> column. `totalFees` sets the one-time part (for students without
 * a monthly fee it is simply the total).
 */
const COLUMNS = {
  name: 'name',
  fatherName: 'father_name',
  contact: 'contact',
  parentMobile: 'parent_mobile',
  rollNo: 'roll_no',
  email: 'email',
  dateOfBirth: 'date_of_birth',
  totalFees: 'total_fees',
  monthlyFee: 'monthly_fee',
  feeStart: 'fee_start',
  feesDueDate: 'fees_due_date',
  disabled: 'disabled',
};

module.exports = { toPublic, feesDue, totalDue, monthsBilled, round2, COLUMNS };
