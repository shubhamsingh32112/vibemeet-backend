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
          if ((buyer.coins || 0) < moment.priceCoins) {
            throw new Error('Insufficient coins');
          }

          const creator = await Creator.findById(moment.creatorId).session(session);
          if (!creator) throw new Error('Creator not found');
          const creatorUser = await User.findById(creator.userId).session(session);
          if (!creatorUser) throw new Error('Creator user not found');

          const gross = moment.priceCoins;
          const creatorShare = Math.floor(gross * cfg.creatorRevenueShare);
          const platformShare = gross - creatorShare;

          buyer.coins = (buyer.coins || 0) - gross;
          await buyer.save({ session });

          creatorUser.coins = (creatorUser.coins || 0) + creatorShare;
          creator.earningsCoins = (creator.earningsCoins || 0) + creatorShare;
          await creatorUser.save({ session });
          await creator.save({ session });

          const purchaseObjectId = new mongoose.Types.ObjectId();
          const revenueObjectId = new mongoose.Types.ObjectId();

          const [debitTx] = await CoinTransaction.create(
            [
              {
                transactionId: txnId,
                userId: buyer._id,
                type: 'debit',
                coins: gross,
                source: 'moment_purchase',
                description: `Unlock moment ${moment._id}`,
                status: 'completed',
              },
            ],
            { session },
          );

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
                creatorLedgerEntryId: creditTx._id,
                entitlementVersion: cfg.entitlementVersion,
                revenueRecordId: revenue._id,
              },
            ],
            { session },
          );

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
