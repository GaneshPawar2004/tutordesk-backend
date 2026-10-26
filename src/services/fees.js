import { addMonths, isoDate, parseDate } from '../lib/util.js';

export const FREQUENCIES = { monthly: 1, quarterly: 3, halfYearly: 6, custom: 0 };
export const PAYMENT_METHODS = ['cash', 'upi', 'bankTransfer', 'cheque', 'card'];

/** Splits the annual fee; the last instalment absorbs any remainder. */
export function buildSchedule({ annualFee, installmentCount, frequency, firstDueDate }) {
  if (!installmentCount || annualFee <= 0) return [];
  const base = Math.floor(annualFee / installmentCount);
  const remainder = annualFee - base * installmentCount;
  const step = FREQUENCIES[frequency] || Math.min(12, Math.max(1, Math.floor(10 / installmentCount)));
  const first = parseDate(firstDueDate);
  return Array.from({ length: installmentCount }, (_, i) => ({
    number: i + 1,
    dueDate: isoDate(addMonths(first, i * step)),
    amount: base + (i === installmentCount - 1 ? remainder : 0),
  }));
}

export const planFor = (t, enrollmentId) => t.feePlans.find((p) => p.enrollmentId === enrollmentId);

export const paymentsFor = (t, enrollmentId) =>
  t.payments
    .filter((p) => p.enrollmentId === enrollmentId)
    .sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));

export function summaryFor(t, enrollmentId, today) {
  const plan = planFor(t, enrollmentId);
  if (!plan) return { agreed: 0, paid: 0, outstanding: 0, overdue: 0, status: 'unpaid', hasPlan: false };
  const paid = paymentsFor(t, enrollmentId).reduce((s, p) => s + p.amount, 0);
  const dueSoFar = buildSchedule(plan)
    .filter((i) => i.dueDate < today)
    .reduce((s, i) => s + i.amount, 0);
  const outstanding = Math.max(0, plan.annualFee - paid);
  return {
    agreed: plan.annualFee,
    paid,
    outstanding,
    overdue: Math.min(plan.annualFee, Math.max(0, dueSoFar - paid)),
    status: paid >= plan.annualFee ? 'paid' : paid > 0 ? 'partial' : 'unpaid',
    hasPlan: true,
  };
}

/** Allocates payments to instalments in order. */
export function installmentProgress(t, enrollmentId, today) {
  const plan = planFor(t, enrollmentId);
  if (!plan) return [];
  let remaining = paymentsFor(t, enrollmentId).reduce((s, p) => s + p.amount, 0);
  return buildSchedule(plan).map((inst) => {
    const allocated = Math.min(remaining, inst.amount);
    remaining -= allocated;
    const state =
      allocated >= inst.amount ? 'paid' : allocated > 0 ? 'partial' : inst.dueDate < today ? 'overdue' : 'due';
    return { ...inst, paid: allocated, state };
  });
}

export function addSummaries(list) {
  const total = list.reduce(
    (acc, s) => ({
      agreed: acc.agreed + s.agreed,
      paid: acc.paid + s.paid,
      outstanding: acc.outstanding + s.outstanding,
      overdue: acc.overdue + s.overdue,
    }),
    { agreed: 0, paid: 0, outstanding: 0, overdue: 0 },
  );
  return total;
}
