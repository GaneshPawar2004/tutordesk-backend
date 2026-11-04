const config = require('../config');

const DAY = 86400000;

/**
 * Whether an institute (its owner and all staff) may use the app now.
 * - trial:   until trial_ends_at
 * - active:  until access_until (null = no end), set with "Allow" on the admin page
 * - blocked: never
 */
function accessOf(inst, now = Date.now()) {
  const trialLeft = inst.trial_ends_at.getTime() - now;
  const base = {
    status: inst.access_status,
    accessUntil: inst.access_until,
    trialEndsAt: inst.trial_ends_at,
    trialDaysRemaining: Math.max(0, Math.ceil(trialLeft / DAY)),
  };
  switch (inst.access_status) {
    case 'blocked':
      return { ...base, allowed: false, code: 'ACCESS_BLOCKED', message: 'Your account has been paused.' };
    case 'active': {
      const ok = !inst.access_until || inst.access_until.getTime() > now;
      return ok
        ? { ...base, allowed: true }
        : { ...base, allowed: false, code: 'ACCESS_EXPIRED', message: 'Your plan has ended.' };
    }
    default:
      return trialLeft > 0
        ? { ...base, allowed: true }
        : { ...base, allowed: false, code: 'ACCESS_EXPIRED', message: 'Your free trial has ended.' };
  }
}

/** Contact shown to teachers whose access ended. */
const support = () => ({ phone: config.supportPhone, email: config.supportEmail });

module.exports = { accessOf, support };
