import { HttpError } from '../lib/errors.js';

/**
 * Small in-memory limiter for the auth routes (login, register, invite):
 * at most `max` requests per IP per window. Enough for a single server.
 */
export function rateLimit({ windowMs, max }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [ip, h] of hits) if (h.reset <= now) hits.delete(ip);
  }, windowMs).unref();

  return (req, _res, next) => {
    const now = Date.now();
    let h = hits.get(req.ip);
    if (!h || h.reset <= now) {
      h = { count: 0, reset: now + windowMs };
      hits.set(req.ip, h);
    }
    h.count += 1;
    if (h.count > max) {
      const minutes = Math.ceil((h.reset - now) / 60_000);
      return next(new HttpError(429, 'too_many_requests', `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`));
    }
    next();
  };
}
