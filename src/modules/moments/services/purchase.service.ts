import mongoose from 'mongoose';
import { randomUUID } from 'crypto';
import { getMomentsConfig } from '../../../config/moments';
import { User } from '../../user/user.model';
import { Creator } from '../../creator/creator.model';
import { CoinTransaction } from '../../user/coin-transaction.model';
import { CreatorMoment } from '../models/creator-moment.model';
import { MomentPurchase } from '../models/moment-purchase.model';
import { MomentRevenue } from '../models/moment-revenue.model';
import {
  withPurchaseLock,
  PurchaseInProgressError,
} from './entitlement.service';
import { toMomentPresentationDTO } from './moment-presentation.service';
import type { PresentationDTO } from '../dto/moment.dto';
import { enqueueAnalyticsEvent } from './analytics-emitter.service';
import {
  getRemainingFreeMoments,
  incrementDailyMomentUsage,
  isVipActive,
  resolveMomentPriceForUser,
} from '../../vip/vip-entitlement.service';

export async function purchaseMoment(input: {
  userId: mongoose.Types.ObjectId;
  momentId: string;
  transactionId?: string;
}): Promise<PresentationDTO> {
  const cfg = getMomentsConfig();
  const txnId = input.transactionId || `moment_${input.momentId}_${input.userId}_${randomUUID()}`;

  return withPurchaseLock(
    input.userId.toString(),
    input.momentId,
    cfg.purchaseLockTtlSec,
    async () => {
      const existingPurchase = await MomentPurchase.findOne({
        userId: input.userId,
        mediaId: input.momentId,
      });
      if (existingPurchase) {
        const moment = await CreatorMoment.findById(input.momentId);
        if (!moment) throw new Error('Moment not found');
        const dto = await toMomentPresentationDTO(moment, { userId: input.userId });
        if (!dto) throw new Error('Moment unavailable');
        return dto;
      }

      const session = await mongoose.startSession();
      try {
        let result: PresentationDTO | null = null;
        await session.withTransaction(async () => {
          const moment = await CreatorMoment.findById(input.momentId).session(session);
          if (!moment || moment.isDeleted) {
            throw new Error('Moment not found');
          }
          if (moment.accessType !== 'paid') {
            throw new Error('Moment is not paid content');
          }
          if (moment.processingStatus !== 'ready' || moment.moderationStatus !== 'approved') {
            throw new Error('Moment not available');
          }

          const buyer = await User.findById(input.userId).session(session);
          if (!buyer) throw new Error('User not found');

          const pricing = await resolveMomentPriceForUser(buyer._id, moment.priceCoins);
          const chargeAmount = pricing.priceCoins;
          const isVipFree = pricing.vipFreeUnlockAvailable && chargeAmount === 0;
          const isVipDiscounted =
            pricing.discountApplied && chargeAmount > 0 && (await isVipActive(buyer._id));

          if (!isVipFree && (buyer.coins || 0) < chargeAmount) {
            throw new Error('Insufficient coins');
          }

          const creator = await Creator.findById(moment.creatorId).session(session);
          if (!creator) throw new Error('Creator not found');
          const creatorUser = await User.findById(creator.userId).session(session);
          if (!creatorUser) throw new Error('Creator user not found');

          if (isVipFree) {
            const remaining = await getRemainingFreeMoments(buyer._id);
            if (remaining <= 0) {
              throw new Error('VIP daily free moment quota exhausted');
            }
          }

          const gross = chargeAmount;
          const creatorShare = isVipFree
            ? 0
            : Math.floor(gross * cfg.creatorRevenueShare);
          const platformShare = gross - creatorShare;

          if (!isVipFree) {
            buyer.coins = (buyer.coins || 0) - gross;
            await buyer.save({ session });
          }

          let creditTxId: mongoose.Types.ObjectId | null = null;
          if (creatorShare > 0) {
            creatorUser.coins = (creatorUser.coins || 0) + creatorShare;
            creator.earningsCoins = (creator.earningsCoins || 0) + creatorShare;
            await creatorUser.save({ session });
            await creator.save({ session });
          }

          const purchaseObjectId = new mongoose.Types.ObjectId();
          const revenueObjectId = new mongoose.Types.ObjectId();

          const debitSource = isVipFree ? 'vip_moment_free' : 'moment_purchase';
          const purchaseSource = isVipFree
            ? 'vip_daily_free'
            : isVipDiscounted
              ? 'vip_discounted'
              : 'coin_purchase';

          const [debitTx] = await CoinTransaction.create(
            [
              {
                transactionId: txnId,
                userId: buyer._id,
                type: 'debit',
                coins: gross,
                source: debitSource,
                description: isVipFree
                  ? `VIP free moment unlock ${moment._id}`
                  : isVipDiscounted
                    ? `Unlock moment ${moment._id} (VIP 10% off)`
                    : `Unlock moment ${moment._id}`,
                status: 'completed',
              },
            ],
            { session },
          );

          if (creatorShare > 0) {
            const creatorTxnId = `${txnId}_creator`;
            const [creditTx] = await CoinTransaction.create(
              [
                {
                  transactionId: creatorTxnId,
                  userId: creatorUser._id,
                  type: 'credit',
                  coins: creatorShare,
                  source: 'moment_earnings',
                  description: `Moment purchase earnings`,
                  status: 'completed',
                },
              ],
              { session },
            );
            creditTxId = creditTx._id;
          }

          const revenue = (
            await MomentRevenue.create(
              [
                {
                  _id: revenueObjectId,
                  purchaseId: purchaseObjectId,
                  momentId: moment._id,
                  creatorId: creator._id,
                  buyerUserId: buyer._id,
                  grossCoins: gross,
                  creatorShareCoins: creatorShare,
                  platformShareCoins: platformShare,
                },
              ],
              { session },
            )
          )[0];

          await MomentPurchase.create(
            [
              {
                _id: purchaseObjectId,
                userId: buyer._id,
                mediaId: moment._id,
                amountCoins: gross,
                transactionId: txnId,
                ledgerEntryId: debitTx._id,
                creatorLedgerEntryId: creditTxId,
                entitlementVersion: cfg.entitlementVersion,
                revenueRecordId: revenue._id,
                purchaseSource,
              },
            ],
            { session },
          );

          if (isVipFree) {
            await incrementDailyMomentUsage(buyer._id);
          }

          moment.purchaseCount += 1;
          await moment.save({ session });

          result = await toMomentPresentationDTO(moment, { userId: input.userId });
        });
        if (!result) throw new Error('Purchase failed');
        await enqueueAnalyticsEvent({
          type: 'moment_purchased',
          userId: input.userId.toString(),
          targetId: input.momentId,
        });
        return result;
      } finally {
        await session.endSession();
      }
    },
  );
}

export { PurchaseInProgressError };
