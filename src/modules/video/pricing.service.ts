import { Creator } from '../creator/creator.model';
import { CREATOR_SHARE_PERCENTAGE } from '../../config/pricing.config';

export interface PricingSnapshot {
  pricePerMinute: number;
  pricePerSecond: number;
  /** Coins accrued per second for the creator (share of tier price per minute). */
  creatorEarningsPerSecond: number;
  creatorShareAtCallTime: number;
}

/**
 * User pays pricePerMinute/60 per second; creator earns (pricePerMinute * share) / 60 per second.
 */
export class PricingService {
  async snapshotForCreator(creatorMongoId: string): Promise<PricingSnapshot> {
    const creator = await Creator.findById(creatorMongoId);
    if (!creator) {
      throw new Error(`Creator not found for pricing snapshot: ${creatorMongoId}`);
    }

    const pricePerMinute = creator.price;
    const pricePerSecond = pricePerMinute / 60;
    const creatorEarningsPerSecond = (pricePerMinute * CREATOR_SHARE_PERCENTAGE) / 60;

    return {
      pricePerMinute,
      pricePerSecond,
      creatorEarningsPerSecond,
      creatorShareAtCallTime: CREATOR_SHARE_PERCENTAGE,
    };
  }
}

export const pricingService = new PricingService();

