import { badRequest } from './errors.js';

/** Deterministic PRNG so seed data is identical on every start. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Local calendar date as YYYY-MM-DD. */
export function isoDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function parseDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

export function addMonths(d, n) {
  return new Date(d.getFullYear(), d.getMonth() + n, Math.min(d.getDate(), 28));
}

export const formatInr = (n) => `₹${Math.round(n).toLocaleString('en-IN')}`;

// ---- request validation helpers -------------------------------------------

export function str(body, key, { optional = false, min = 1, max = 200 } = {}) {
  const v = body?.[key];
  if (v === undefined || v === null || v === '') {
    if (optional) return undefined;
    throw badRequest(`${key} is required`, { field: key });
  }
  if (typeof v !== 'string') throw badRequest(`${key} must be text`, { field: key });
  const t = v.trim();
  if (t.length < min || t.length > max) throw badRequest(`${key} must be ${min}–${max} characters`, { field: key });
  return t;
}

export function int(body, key, { optional = false, min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const v = body?.[key];
  if (v === undefined || v === null || v === '') {
    if (optional) return undefined;
    throw badRequest(`${key} is required`, { field: key });
  }
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw badRequest(`${key} must be a whole number between ${min} and ${max}`, { field: key });
  }
  return n;
}

export function date(body, key, { optional = false } = {}) {
  const v = body?.[key];
  if (v === undefined || v === null || v === '') {
    if (optional) return undefined;
    throw badRequest(`${key} is required`, { field: key });
  }
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    throw badRequest(`${key} must be a date (YYYY-MM-DD)`, { field: key });
  }
  return v;
}

export function oneOf(body, key, values, { optional = false } = {}) {
  const v = body?.[key];
  if (v === undefined || v === null) {
    if (optional) return undefined;
    throw badRequest(`${key} is required`, { field: key });
  }
  if (!values.includes(v)) throw badRequest(`${key} must be one of: ${values.join(', ')}`, { field: key });
  return v;
}

export function phone(body, key, { optional = false } = {}) {
  const v = str(body, key, { optional, max: 20 });
  if (v === undefined) return undefined;
  const digits = v.replace(/\D/g, '').slice(-10);
  if (!/^[6-9]\d{9}$/.test(digits)) throw badRequest(`${key} must be a 10-digit Indian mobile number`, { field: key });
  return digits;
}
