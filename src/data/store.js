import { buildSeed } from './seed.js';

/**
 * In-memory, tenant-partitioned store. Every request resolves exactly one
 * tenant from its token and only ever touches that tenant's data, which keeps
 * the route code shaped for a real per-tenant database later.
 */
export class Store {
  constructor({ now = new Date() } = {}) {
    this.tenants = new Map();
    const seed = buildSeed(now);
    this.tenants.set(seed.tuition.id, seed);
  }

  tenant(id) {
    return this.tenants.get(id) ?? null;
  }
}

/** Next sequential id for a tenant, e.g. nextId(t, 'payment', 'pay') → "pay-10001". */
export function nextId(t, kind, prefix) {
  t.counters[kind] = (t.counters[kind] ?? 0) + 1;
  return `${prefix}-${t.counters[kind]}`;
}
