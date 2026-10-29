import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);

/** scrypt with a random salt; stored as "scrypt$<salt>$<hash>". */
export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = await scryptAsync(password, salt, 64);
  return `scrypt$${salt}$${hash.toString('hex')}`;
}

export async function verifyPassword(password, stored) {
  if (!stored?.startsWith('scrypt$')) return false;
  const [, salt, hex] = stored.split('$');
  const expected = Buffer.from(hex, 'hex');
  const actual = await scryptAsync(password, salt, expected.length);
  return timingSafeEqual(actual, expected);
}

/** Short human-friendly code for staff invitations (no 0/O/1/I). */
export function inviteCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(randomBytes(6), (b) => alphabet[b % alphabet.length]).join('');
}
