const round2 = (n) => Math.round(n * 100) / 100;

const feesDue = (st) => Math.max(0, round2(st.total_fees - st.fees_paid));

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
      totalFees: st.total_fees,
      feesPaid: st.fees_paid,
      feesDue: feesDue(st),
      feesDueDate: st.fees_due_date,
    });
  }
  return out;
}

/** API field -> column. */
const COLUMNS = {
  name: 'name',
  fatherName: 'father_name',
  contact: 'contact',
  parentMobile: 'parent_mobile',
  rollNo: 'roll_no',
  email: 'email',
  dateOfBirth: 'date_of_birth',
  totalFees: 'total_fees',
  feesDueDate: 'fees_due_date',
  disabled: 'disabled',
};

module.exports = { toPublic, feesDue, round2, COLUMNS };
