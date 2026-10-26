import { formatInr } from '../lib/util.js';

const pct = (v) => {
  const r = Math.round(v * 10) / 10;
  return Number.isInteger(r) ? `${r}%` : `${r.toFixed(1)}%`;
};

export const attendanceMessage = (status, student, tuition) =>
  ({
    present: `Dear Parent, your child ${student} was marked PRESENT at ${tuition} today.`,
    absent: `Dear Parent, your child ${student} was marked ABSENT at ${tuition} today. Please contact us if this is incorrect.`,
    late: `Dear Parent, your child ${student} arrived LATE at ${tuition} today.`,
    leave: `Dear Parent, your child ${student} was marked ON LEAVE at ${tuition} today.`,
  })[status];

export function examResultMessage(examName, student, result, tuition) {
  const lines = result.subjects
    .map((s) => (s.absent ? `${s.subject}: Absent` : s.marks === null ? `${s.subject}: Not entered` : `${s.subject}: ${s.marks}/${s.maxMarks}`))
    .join('\n');
  return (
    `Dear Parent, the ${examName} results for ${student} are available.\n\n${lines}\n\n` +
    `Total: ${result.obtained}/${result.maxTotal}\nPercentage: ${pct(result.percent)}\n\nRegards,\n${tuition}`
  );
}

export const feeReminderMessage = (student, amount, tuition) =>
  `Dear Parent, a fee balance of ${formatInr(amount)} is due for ${student} at ${tuition}. ` +
  'Please clear it at your earliest convenience. Ignore if already paid.';

export const announcementMessage = (title, body, tuition) => `${title}\n\n${body}\n\n– ${tuition}`;
