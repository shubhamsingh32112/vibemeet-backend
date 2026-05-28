import { normalizePhone } from '../user/deleted-identity.service';

const MIN_DIGITS = 10;
const MAX_PHONE_LENGTH = 20;

/**
 * Validates contact phone for support tickets (E.164-style: must start with +).
 */
export function validateSupportContactPhone(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new Error('Phone number is required');
  }
  const trimmed = raw.trim();
  if (!trimmed.startsWith('+')) {
    throw new Error('Phone number must include country code (e.g. +91...)');
  }
  if (trimmed.length > MAX_PHONE_LENGTH) {
    throw new Error('Phone number is too long');
  }
  const normalized = normalizePhone(trimmed);
  const digits = normalized.replace(/\D/g, '');
  if (digits.length < MIN_DIGITS) {
    throw new Error('Phone number must have at least 10 digits');
  }
  return normalized;
}
