const markToPublic = (m) => ({
  student: m.student_id,
  marks: m.marks,
  remarks: m.remarks,
  skip: m.skip,
});

/** `tests` row + its `test_marks` rows (in order) -> API object. */
const toPublic = (t, marks) => ({
  id: t.id,
  class: t.class_id,
  subject: t.subject,
  maxMarks: t.max_marks,
  gradedCount: marks.filter((m) => !m.skip && m.marks != null).length,
  marks: marks.map(markToPublic),
  createdAt: t.created_at,
});

module.exports = { toPublic };
