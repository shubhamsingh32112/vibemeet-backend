import { randomInt } from 'crypto';

/** Trim portal login / change-password input (consistent across staff auth). */
export function normalizeStaffPortalPassword(raw: unknown): string {
  return String(raw ?? '').trim();
}

/** Random password for agency/BD provisioning (display once to operators). */
export function generateStaffPortalPassword(length = 14): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < length; i++) {
    out += alphabet[randomInt(alphabet.length)];
  }
  return out;
}
