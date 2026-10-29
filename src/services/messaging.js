import { COLS, newId } from '../data/repo.js';

/**
 * Message batches stored in Postgres. A unique (tenant_id, source_key)
 * constraint makes batch creation idempotent even under concurrent requests.
 *
 * Two transports, chosen per tenant by `tenants.sms.mode`:
 * - 'simulated': timers move recipients queued → sending → sent/failed → delivered.
 * - 'device': recipients stay queued; an Android phone running the TutorDesk app
 *   claims them (queued → sending), sends from its SIM and reports back.
 */
const STALE_MINUTES = 10;

export function createMessaging(db, { simulate = true, speed = 1 } = {}) {
  const timers = new Set();
  const later = (ms, fn) => {
    const id = setTimeout(() => {
      timers.delete(id);
      fn().catch((e) => console.error('[sms-sim]', e.message));
    }, ms / speed);
    timers.add(id);
  };
  const setStatus = (id, status, reason = null, bumpAttempt = false) =>
    db.query(
      `update message_recipients set status = $2, failure_reason = $3, updated_at = now()${bumpAttempt ? ', attempts = attempts + 1' : ''}
        where id = $1 returning attempts, phone`,
      [id, status, reason],
    );
  const failsFirstAttempt = (phone) => Number(phone.slice(-2)) % 6 === 0;

  const countUsage = (tenantId) =>
    db.query(
      `update tenants set sms = jsonb_set(sms, '{usedThisMonth}', to_jsonb(coalesce((sms->>'usedThisMonth')::int, 0) + 1)) where id = $1`,
      [tenantId],
    );

  async function dispatch(tenantId, recipients) {
    if (!simulate || !recipients.length) return;
    const { sms } = await db.one('select sms from tenants where id = $1', [tenantId]);
    if (sms?.mode === 'device') return; // the sending phone picks them up
    const stagger = recipients.length > 40 ? 70 : 220;
    recipients.forEach((r, i) => {
      later(300 + i * stagger, async () => {
        await setStatus(r.id, 'sending');
        later(650, async () => {
          const [row] = await db.query('select attempts, phone from message_recipients where id = $1', [r.id]);
          if (!row) return;
          const fail = row.attempts === 0 && failsFirstAttempt(row.phone);
          await setStatus(r.id, fail ? 'failed' : 'sent', fail ? 'Device reported send failure (simulated)' : null, true);
          if (fail) return;
          await countUsage(tenantId);
          if (Number(row.phone.at(-1)) % 2 === 0) later(1400, () => setStatus(r.id, 'delivered'));
        });
      });
    });
  }

  return {
    async createBatch(tenantId, { sourceKey, title, category, classIds, createdBy, previewBody, recipients }) {
      const result = await db.tx(async (t) => {
        const batch = await t.one(
          `insert into message_batches (id, tenant_id, source_key, title, category, class_ids, created_by, preview_body)
           values ($1, $2, $3, $4, $5, $6, $7, $8)
           on conflict (tenant_id, source_key) do nothing
           returning ${COLS.batch}`,
          [newId(), tenantId, sourceKey, title, category, classIds, createdBy, previewBody],
        );
        if (!batch) return { created: false };
        const rows = [];
        for (const [i, r] of recipients.entries()) {
          rows.push(
            await t.one(
              `insert into message_recipients (id, tenant_id, batch_id, position, student_id, student_name, parent_name, phone, body)
               values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning ${COLS.recipient}`,
              [newId(), tenantId, batch.id, i, r.studentId ?? null, r.studentName, r.parentName, r.phone, r.body],
            ),
          );
        }
        return { created: true, batch, rows };
      });
      if (!result.created) {
        const existing = await db.one(`select id from message_batches where tenant_id = $1 and source_key = $2`, [tenantId, sourceKey]);
        return { created: false, batchId: existing.id };
      }
      await dispatch(tenantId, result.rows);
      return { created: true, batchId: result.batch.id };
    },

    /** Re-dispatches failed recipients only; sent/delivered ones are never touched. */
    async retry(tenantId, batchId) {
      const failed = await db.query(
        `update message_recipients set status = 'queued', failure_reason = null, updated_at = now()
          where batch_id = $1 and tenant_id = $2 and status = 'failed' returning id`,
        [batchId, tenantId],
      );
      const pending = await db.query(
        `select id from message_recipients where batch_id = $1 and tenant_id = $2 and status = 'queued' and attempts = 0`,
        [batchId, tenantId],
      );
      const all = [...failed, ...pending.filter((p) => !failed.some((f) => f.id === p.id))];
      await dispatch(tenantId, all);
      return { retried: failed.length, pending: all.length - failed.length };
    },

    /**
     * Device transport: hands up to `limit` queued messages to the sending phone.
     * Each row moves to 'sending' exactly once per attempt (skip locked), so two
     * phones or two polls never send the same message. Messages the phone took
     * but never reported on are failed after STALE_MINUTES — never auto-resent.
     */
    async claim(tenantId, { limit = 10, deviceName }) {
      await db.query(
        `update message_recipients set status = 'failed', updated_at = now(),
                failure_reason = 'No report from the sending phone — it may or may not have been sent'
          where tenant_id = $1 and status = 'sending' and updated_at < now() - interval '${STALE_MINUTES} minutes'`,
        [tenantId],
      );
      await db.query(
        `update tenants set sms = sms || jsonb_build_object('deviceName', $2::text, 'lastSeenAt', now()) where id = $1`,
        [tenantId, deviceName],
      );
      return db.query(
        `update message_recipients set status = 'sending', attempts = attempts + 1, updated_at = now()
          where id in (
            select r.id from message_recipients r join message_batches b on b.id = r.batch_id
             where r.tenant_id = $1 and r.status = 'queued'
             order by b.created_at, r.position
             limit $2 for update of r skip locked)
          returning id, phone, body`,
        [tenantId, limit],
      );
    },

    /** Switching back to simulated mode: hand waiting messages to the simulator. */
    async flushQueued(tenantId) {
      const rows = await db.query(`select id from message_recipients where tenant_id = $1 and status = 'queued'`, [tenantId]);
      await dispatch(tenantId, rows);
    },

    /** Device transport: the phone reports 'sent', 'failed' or 'delivered'. */
    async report(tenantId, { id, status, reason }) {
      const allowed = { sent: ['sending'], failed: ['sending'], delivered: ['sending', 'sent'] };
      const [row] = await db.query(
        `update message_recipients set status = $3, failure_reason = $4, updated_at = now()
          where id = $1 and tenant_id = $2 and status = any($5) returning id`,
        [id, tenantId, status, status === 'failed' ? reason || 'Phone could not send the SMS' : null, allowed[status]],
      );
      if (row && status === 'sent') await countUsage(tenantId);
      return Boolean(row);
    },

    close() {
      for (const t of timers) clearTimeout(t);
      timers.clear();
    },
  };
}

export function batchStats(recipients) {
  const count = (fn) => recipients.filter(fn).length;
  return {
    total: recipients.length,
    delivered: count((r) => r.status === 'delivered'),
    sent: count((r) => r.status === 'sent' || r.status === 'delivered'),
    failed: count((r) => r.status === 'failed'),
    pending: count((r) => r.status === 'queued' || r.status === 'sending'),
  };
}
