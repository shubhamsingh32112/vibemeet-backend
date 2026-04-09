/**
 * Escape a string for safe use as a literal inside a MongoDB / JS RegExp.
 * Matches the pattern used in agent user search (substring match, case-insensitive).
 */
export function escapeMongoRegexLiteral(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Case-insensitive substring regex for username / email / phone search. */
export function buildSafeMongoSubstringRegex(trimmed: string): RegExp {
  return new RegExp(escapeMongoRegexLiteral(trimmed), 'i');
}

/** Max length for admin user search query strings (ReDoS / UX guard). */
export const ADMIN_USER_SEARCH_QUERY_MAX_LEN = 128;
