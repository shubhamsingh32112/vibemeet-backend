import { Creator } from '../creator/creator.model';
import {
  CREATOR_EARNINGS_PER_SECOND,
  CREATOR_SHARE_PERCENTAGE,
} from '../../config/pricing.config';

export interface PricingSnapshot {
  pricePerMinute: number;
  pricePerSecond: number;
  creatorEarningsPerSecond: number;
  creatorShareAtCallTime: number;
}

/**
 * Thin wrapper around current pricing configuration.
 *
 * This centralises how effective pricing is computed so that when
 * you introduce a proper Pricing/RevenueShare model later, you only
 * need to change this module.
 */
export class PricingService {
  async snapshotForCreator(creatorMongoId: string): Promise<PricingSnapshot> {
    const creator = await Creator.findById(creatorMongoId);
    if (!creator) {
      throw new Error(`Creator not found for pricing snapshot: ${creatorMongoId}`);
    }

    const pricePerMinute = creator.price;
    const pricePerSecond = pricePerMinute / 60;

    return {
      pricePerMinute,
      pricePerSecond,
      creatorEarningsPerSecond: CREATOR_EARNINGS_PER_SECOND,
      creatorShareAtCallTime: CREATOR_SHARE_PERCENTAGE,
    };
  }
}

export const pricingService = new PricingService();

