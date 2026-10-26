export function gradeFor(percent) {
  if (percent >= 90) return { label: 'A+', remark: 'Outstanding' };
  if (percent >= 75) return { label: 'A', remark: 'Excellent' };
  if (percent >= 60) return { label: 'B', remark: 'Good' };
  if (percent >= 45) return { label: 'C', remark: 'Satisfactory' };
  if (percent >= 35) return { label: 'D', remark: 'Pass' };
  return { label: 'E', remark: 'Needs improvement' };
}

/** Totals are always computed from subject marks. Absent counts as 0 obtained. */
export function resultFor(t, exam, studentId) {
  const subjects = exam.subjects.map((s) => {
    const entry = exam.marks[s.subjectId]?.[studentId] ?? null;
    const absent = entry?.absent === true;
    const marks = absent ? null : (entry?.marks ?? null);
    return {
      subjectId: s.subjectId,
      subject: t.subjects.find((x) => x.id === s.subjectId)?.name ?? s.subjectId,
      maxMarks: s.maxMarks,
      marks,
      absent,
      entered: absent || marks !== null,
    };
  });
  const obtained = subjects.reduce((sum, s) => sum + (s.marks ?? 0), 0);
  const maxTotal = subjects.reduce((sum, s) => sum + s.maxMarks, 0);
  const percent = maxTotal === 0 ? 0 : (obtained * 100) / maxTotal;
  return {
    studentId,
    subjects,
    obtained,
    maxTotal,
    percent: Math.round(percent * 10) / 10,
    complete: subjects.every((s) => s.entered),
    absentInAll: subjects.length > 0 && subjects.every((s) => s.absent),
    grade: gradeFor(percent),
  };
}

export function examStatus(exam, today) {
  if (exam.isDraft) return 'draft';
  if (exam.resultsPublished) return 'published';
  if (exam.date > today) return 'upcoming';
  return 'completed';
}

export function marksProgress(exam, roster) {
  let entered = 0;
  let total = 0;
  for (const s of exam.subjects) {
    for (const st of roster) {
      total++;
      const e = exam.marks[s.subjectId]?.[st.id];
      if (e && (e.absent || e.marks !== null)) entered++;
    }
  }
  return { entered, total };
}
