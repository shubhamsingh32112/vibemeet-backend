import { Creator } from '../creator/creator.model';
import { getRedis } from '../../config/redis';
import { CREATOR_SHARE_PERCENTAGE } from '../../config/pricing.config';
import {
  COIN_MICROS,
  pricePerMinuteToCreatorMicrosPerSecond,
  pricePerMinuteToUserMicrosPerSecond,
} from '../billing/billing.constants';
import { logDebug } from '../../utils/logger';

/** Redis: cached JSON of [PricingSnapshot] per creator (TTL seconds). */
const PRICING_SNAPSHOT_CACHE_PREFIX = 'billing:pricing:snap:';
const PRICING_SNAPSHOT_CACHE_TTL = 300;

export interface PricingSnapshot {
  pricePerMinute: number;
  /** @deprecated use pricePerSecondMicros; kept for API/clients */
  pricePerSecond: number;
  /** @deprecated use creatorEarningsPerSecondMicros */
  creatorEarningsPerSecond: number;
  creatorShareAtCallTime: number;
  /** Integer: user coins charged per second in micro-coins */
  pricePerSecondMicros: number;
  /** Integer: creator earnings per second in micro-coins */
  creatorEarningsPerSecondMicros: number;
}

/**
 * User pays pricePerMinute/60 per second; creator earns (pricePerMinute * share) / 60 per second.
 * Per-second rates are exposed as integer micro-coins (COIN_MICROS per 1 coin).
 */
function buildSnapshotFromPricePerMinute(pricePerMinute: number): PricingSnapshot {
  const pricePerSecondMicros = pricePerMinuteToUserMicrosPerSecond(pricePerMinute);
  const creatorEarningsPerSecondMicros = pricePerMinuteToCreatorMicrosPerSecond(
    pricePerMinute,
    CREATOR_SHARE_PERCENTAGE
  );
  return {
    pricePerMinute,
    pricePerSecond: pricePerSecondMicros / COIN_MICROS,
    creatorEarningsPerSecond: creatorEarningsPerSecondMicros / COIN_MICROS,
    pricePerSecondMicros,
    creatorEarningsPerSecondMicros,
    creatorShareAtCallTime: CREATOR_SHARE_PERCENTAGE,
  };
}

export class PricingService {
  async snapshotForCreator(creatorMongoId: string): Promise<PricingSnapshot> {
    const creator = await Creator.findById(creatorMongoId);
    if (!creator) {
      throw new Error(`Creator not found for pricing snapshot: ${creatorMongoId}`);
    }
    return buildSnapshotFromPricePerMinute(creator.price);
  }

  /**
   * Build the pricing snapshot from an already-loaded creator row (no extra DB
   * hit). Use this in startBillingSession after a single [`Creator`][`find`].
   */
  snapshotFromLoadedCreator(creator: { price: number; _id?: unknown }): PricingSnapshot {
    return buildSnapshotFromPricePerMinute(creator.price);
  }

  /**
   * Warm the Redis cache so a subsequent `snapshotForCreatorCached` hits memory.
   */
  async warmSnapshotCache(creatorObjectId: string, snapshot: PricingSnapshot): Promise<void> {
    const redis = getRedis();
    const key = `${PRICING_SNAPSHOT_CACHE_PREFIX}${creatorObjectId}`;
    await redis.setex(key, PRICING_SNAPSHOT_CACHE_TTL, JSON.stringify(snapshot)).catch((e) =>
      logDebug('Pricing cache warm failed (non-fatal)', { e })
    );
  }

  /**
   * Same as snapshotForCreator but uses Redis to avoid a duplicate Creator
   * find on hot billing starts (5 min TTL, invalidate via admin on price change).
   */
  async snapshotForCreatorCached(creatorObjectId: string): Promise<PricingSnapshot> {
    const redis = getRedis();
    const key = `${PRICING_SNAPSHOT_CACHE_PREFIX}${creatorObjectId}`;
    const raw = await redis.get(key);
    if (raw) {
      try {
        return JSON.parse(raw) as PricingSnapshot;
      } catch {
        /* load from DB */
      }
    }
    const creator = await Creator.findById(creatorObjectId);
    if (!creator) {
      throw new Error(`Creator not found for pricing snapshot: ${creatorObjectId}`);
    }
    const snap = buildSnapshotFromPricePerMinute(creator.price);
    await redis
      .setex(key, PRICING_SNAPSHOT_CACHE_TTL, JSON.stringify(snap))
      .catch((e) => logDebug('Pricing cache set failed (non-fatal)', { e }));
    return snap;
  }
}

/** Bust per-creator pricing cache after admin price update (call from creator routes). */
export async function invalidateCreatorPricingCache(creatorObjectId: string): Promise<void> {
  try {
    const redis = getRedis();
    await redis.del(`${PRICING_SNAPSHOT_CACHE_PREFIX}${creatorObjectId}`);
  } catch {
    /* ignore */
  }
}

export const pricingService = new PricingService();
