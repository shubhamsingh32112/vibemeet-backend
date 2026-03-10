/**
 * Referral Code Generation Utility
 *
 * Format: 6 characters = [First 2 letters of name][4 random numbers]
 * Examples: JO4832, AL9021, MI1234
 * Fallback when name missing: US + 4 random numbers (e.g. US9284)
 *
 * Rules:
 * - Uppercase letters only
 * - Globally unique (caller must check uniqueness and retry on collision)
 */

const DIGITS = '0123456789';

/**
 * Extract first two uppercase letters from a name string.
 * Falls back to 'US' if name is missing or has insufficient letters.
 */
function getPrefixFromName(name: string | null | undefined): string {
  if (!name || typeof name !== 'string') return 'US';

  // Remove non-alpha, take first 2 chars, uppercase
  const cleaned = name.replace(/[^a-zA-Z]/g, '').slice(0, 2).toUpperCase();

  if (cleaned.length < 2) return 'US';
  return cleaned;
}

/**
 * Generate 4 random decimal digits.
 */
function random4Digits(): string {
  let result = '';
  for (let i = 0; i < 4; i++) {
    result += DIGITS[Math.floor(Math.random() * DIGITS.length)];
  }
  return result;
}

/**
 * Generate a referral code from a user's name.
 *
 * @param name - User's display name (username, email local part, or "User")
 * @returns 6-character code: 2 letters + 4 digits (e.g. JO4832, US9284)
 */
export function generateReferralCode(name?: string | null): string {
  const prefix = getPrefixFromName(name);
  const digits = random4Digits();
  return `${prefix}${digits}`;
}

/** Referral code validation: exactly 6 chars, 2 uppercase letters + 4 digits */
const REFERRAL_CODE_REGEX = /^[A-Z]{2}\d{4}$/;

/**
 * Validate referral code format.
 *
 * @param code - Candidate referral code
 * @returns true if format is valid (2 uppercase letters + 4 digits)
 */
export function isValidReferralCodeFormat(code: string | null | undefined): boolean {
  if (!code || typeof code !== 'string') return false;
  const trimmed = code.trim().toUpperCase();
  return trimmed.length === 6 && REFERRAL_CODE_REGEX.test(trimmed);
}

/**
 * Normalize referral code for lookup (uppercase, trimmed).
 */
export function normalizeReferralCode(code: string): string {
  return code.trim().toUpperCase();
}

/** Max retries when generating unique referral code */
const MAX_UNIQUE_RETRIES = 10;

/**
 * Generate a unique referral code by checking against the database.
 * Retries on collision (up to MAX_UNIQUE_RETRIES times).
 *
 * @param name - User's display name for prefix
 * @param existsChecker - Async function that returns true if code already exists
 * @returns Unique 6-character referral code
 * @throws Error if unable to generate unique code after retries
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
