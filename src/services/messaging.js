import { nextId } from '../data/store.js';

/**
 * Batch creation and a simulated sender. The simulation never contacts any
 * provider: statuses move queued → sending → sent/failed → delivered on timers.
 * A real transport (phone SIM app, gateway) would replace `dispatch`.
 */
export function createMessaging({ simulate = true, speed = 1 } = {}) {
  const timers = new Set();
  const later = (ms, fn) => {
    const id = setTimeout(() => {
      timers.delete(id);
      fn();
    }, ms / speed);
    timers.add(id);
  };
  const failsFirstAttempt = (phone) => Number(phone.slice(-2)) % 6 === 0;
  const touch = (r, status, failureReason = null) => {
    r.status = status;
    r.failureReason = failureReason;
    r.updatedAt = new Date().toISOString();
  };

  function dispatch(t, batch, recipients) {
    if (!simulate) return;
    const stagger = recipients.length > 40 ? 70 : 220;
    recipients.forEach((r, i) => {
      touch(r, 'queued');
      later(300 + i * stagger, () => {
        touch(r, 'sending');
        later(650, () => {
          r.attempts += 1;
          const fail = r.attempts === 1 && failsFirstAttempt(r.phone);
          touch(r, fail ? 'failed' : 'sent', fail ? 'Device reported send failure' : null);
          if (!fail) t.sms.usedThisMonth += 1;
          if (!fail && Number(r.phone.at(-1)) % 2 === 0) later(1400, () => touch(r, 'delivered'));
        });
      });
    });
  }

  return {
    /** Idempotent on sourceKey: an existing batch is returned, never re-sent. */
    createBatch(t, { sourceKey, title, category, classIds, createdBy, previewBody, recipients }) {
      const existing = t.batches.find((b) => b.sourceKey === sourceKey);
      if (existing) return { batch: existing, created: false };
      const id = nextId(t, 'batch', 'bat');
      const batch = {
        id,
        sourceKey,
        title,
        category,
        classIds,
        createdBy,
        createdAt: new Date().toISOString(),
        previewBody,
        recipients: recipients.map((r, i) => ({
          id: `${id}-r${i}`,
          ...r,
          status: 'queued',
          attempts: 0,
          failureReason: null,
          updatedAt: new Date().toISOString(),
        })),
      };
      t.batches.push(batch);
      dispatch(t, batch, batch.recipients);
      return { batch, created: true };
    },

    /** Re-dispatches failed recipients only; sent/delivered ones are untouched. */
    retryFailed(t, batch) {
      const failed = batch.recipients.filter((r) => r.status === 'failed');
      dispatch(t, batch, failed);
      return failed.length;
    },

    processPending(t, batch) {
      const queued = batch.recipients.filter((r) => r.status === 'queued' && r.attempts === 0);
      dispatch(t, batch, queued);
      return queued.length;
    },

    close() {
      for (const id of timers) clearTimeout(id);
      timers.clear();
    },
  };
}

export function batchStats(b) {
  const count = (fn) => b.recipients.filter(fn).length;
  return {
    total: b.recipients.length,
    delivered: count((r) => r.status === 'delivered'),
    sent: count((r) => r.status === 'sent' || r.status === 'delivered'),
    failed: count((r) => r.status === 'failed'),
    pending: count((r) => r.status === 'queued' || r.status === 'sending'),
  };
}
