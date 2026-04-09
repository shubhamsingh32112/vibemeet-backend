/**
 * Creator video-call price tiers (coins per minute).
 * Only admin and assigned agent may set these when creating/editing a creator profile.
 */
export const ALLOWED_CREATOR_PRICES = [60, 90, 120] as const;

export type AllowedCreatorPrice = (typeof ALLOWED_CREATOR_PRICES)[number];

const ALLOWED_SET = new Set<number>(ALLOWED_CREATOR_PRICES);

export function isAllowedCreatorPrice(n: unknown): n is AllowedCreatorPrice {
  return typeof n === 'number' && Number.isInteger(n) && ALLOWED_SET.has(n);
}

/** Human-readable list for API error messages */
export const ALLOWED_CREATOR_PRICES_DISPLAY = ALLOWED_CREATOR_PRICES.join(', ');

export function assertAllowedCreatorPrice(
  price: unknown
): asserts price is AllowedCreatorPrice {
  if (!isAllowedCreatorPrice(price)) {
    throw new CreatorPriceValidationError(
      `Price must be one of: ${ALLOWED_CREATOR_PRICES_DISPLAY} (coins per minute)`
    );
  }
}

export class CreatorPriceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CreatorPriceValidationError';
  }
}

/**
 * Use in Express handlers: return 400 JSON instead of throwing.
 */
export function validateCreatorPriceForApi(price: unknown): { ok: true; price: AllowedCreatorPrice } | { ok: false; error: string } {
  if (!isAllowedCreatorPrice(price)) {
    return {
      ok: false,
      error: `Price must be one of: ${ALLOWED_CREATOR_PRICES_DISPLAY} (coins per minute)`,
    };
  }
  return { ok: true, price };
}
