/**
 * System-authoritative default per-minute price for new hosts (BD-assisted creation,
 * mobile host-profile completion). Super Admin may override via creator edit APIs only.
 *
 * Env: SYSTEM_DEFAULT_HOST_PRICE_COINS_PER_MIN (must match allowed tiers in creator-price.config).
 */
import { validateCreatorPriceForApi, type AllowedCreatorPrice } from './creator-price.config';

const FALLBACK: AllowedCreatorPrice = 60;

/**
 * Price forced server-side for BD onboarding and host self-completion — never from client body.
 */
export function getSystemDefaultHostPriceForNewHosts(): AllowedCreatorPrice {
  const raw = process.env.SYSTEM_DEFAULT_HOST_PRICE_COINS_PER_MIN?.trim();
  if (!raw) return FALLBACK;
  const n = parseInt(raw, 10);
  const check = validateCreatorPriceForApi(n);
  if (check.ok) return check.price;
  return FALLBACK;
}
