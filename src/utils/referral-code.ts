/**
 * Referral Code Generation Utility
 *
 * Legacy format (6 chars): [First 2 letters of name][4 random digits] e.g. JO4832
 * Current format (8 chars): [First 3 letters of name][5 random digits] e.g. JOE48392
 * Fallback when name missing: USR + 5 digits
 *
 * Validation accepts both legacy and current formats during transition.
 */

const DIGITS = '0123456789';

/**
 * Extract first two uppercase letters from a name string.
 * Falls back to 'US' if name is missing or has insufficient letters.
 */
function getPrefixFromName2(name: string | null | undefined): string {
  if (!name || typeof name !== 'string') return 'US';

  const cleaned = name.replace(/[^a-zA-Z]/g, '').slice(0, 2).toUpperCase();

  if (cleaned.length < 2) return 'US';
  return cleaned;
}

/**
 * Extract first three uppercase letters from a name string.
 * Falls back to 'USR' if name is missing or has insufficient letters.
 */
function getPrefixFromName3(name: string | null | undefined): string {
  if (!name || typeof name !== 'string') return 'USR';

  const cleaned = name.replace(/[^a-zA-Z]/g, '').slice(0, 3).toUpperCase();

  if (cleaned.length === 0) return 'USR';
  if (cleaned.length === 1) return `${cleaned}XX`.slice(0, 3);
  if (cleaned.length === 2) return `${cleaned}X`.slice(0, 3);
  return cleaned;
}

function randomNDigits(n: number): string {
  let result = '';
  for (let i = 0; i < n; i++) {
    result += DIGITS[Math.floor(Math.random() * DIGITS.length)];
  }
  return result;
}

/**
 * @deprecated Legacy 6-character generator — use generateReferralCode for new assignments.
 */
export function generateReferralCodeLegacy(name?: string | null): string {
  const prefix = getPrefixFromName2(name);
  return `${prefix}${randomNDigits(4)}`;
}

/**
 * Generate a referral code from a user's name (8 characters).
 */
export function generateReferralCode(name?: string | null): string {
  const prefix = getPrefixFromName3(name);
  return `${prefix}${randomNDigits(5)}`;
}

/** Legacy: 2 uppercase letters + 4 digits */
const REFERRAL_CODE_REGEX_V1 = /^[A-Z]{2}\d{4}$/;

/** Current: 3 uppercase letters + 5 digits */
const REFERRAL_CODE_REGEX_V2 = /^[A-Z]{3}\d{5}$/;

/**
 * Validate referral code format (legacy 6-char or current 8-char).
 */
export function isValidReferralCodeFormat(code: string | null | undefined): boolean {
  if (!code || typeof code !== 'string') return false;
  const trimmed = code.trim().toUpperCase();
  if (trimmed.length === 6 && REFERRAL_CODE_REGEX_V1.test(trimmed)) return true;
  if (trimmed.length === 8 && REFERRAL_CODE_REGEX_V2.test(trimmed)) return true;
  return false;
}

/**
 * Normalize referral code for lookup (uppercase, trimmed).
 */
export function normalizeReferralCode(code: string): string {
  return code.trim().toUpperCase();
}

/** Max retries when generating unique referral code */
const MAX_UNIQUE_RETRIES = 32;

/**
 * Generate a unique referral code by checking against the database.
 */
export async function generateUniqueReferralCode(
  name: string | null | undefined,
  existsChecker: (code: string) => Promise<boolean>
): Promise<string> {
  for (let i = 0; i < MAX_UNIQUE_RETRIES; i++) {
    const code = generateReferralCode(name);
    const exists = await existsChecker(code);
    if (!exists) return code;
  }
  throw new Error('Unable to generate unique referral code after retries');
}
