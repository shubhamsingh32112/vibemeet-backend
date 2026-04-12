import { Creator } from '../creator/creator.model';
import { CREATOR_SHARE_PERCENTAGE } from '../../config/pricing.config';
import {
  COIN_MICROS,
  pricePerMinuteToCreatorMicrosPerSecond,
  pricePerMinuteToUserMicrosPerSecond,
} from '../billing/billing.constants';

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
export class PricingService {
  async snapshotForCreator(creatorMongoId: string): Promise<PricingSnapshot> {
    const creator = await Creator.findById(creatorMongoId);
    if (!creator) {
      throw new Error(`Creator not found for pricing snapshot: ${creatorMongoId}`);
    }

    const pricePerMinute = creator.price;
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
}

export const pricingService = new PricingService();
