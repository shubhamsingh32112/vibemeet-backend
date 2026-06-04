import mongoose from 'mongoose';
import { randomUUID } from 'crypto';
import { getMomentsConfig } from '../../../config/moments';
import { User } from '../../user/user.model';
import { Creator } from '../../creator/creator.model';
import { CoinTransaction } from '../../user/coin-transaction.model';
import { CreatorMoment } from '../models/creator-moment.model';
import { MomentPurchase } from '../models/moment-purchase.model';
import { MomentRevenue } from '../models/moment-revenue.model';

export interface AuditMomentPurchaseResult {
  purchase: Record<string, unknown> | null;
  moment: Record<string, unknown> | null;
  buyerLedger: Record<string, unknown>[];
  creatorLedger: Record<string, unknown>[];
}

export async function auditMomentPurchase(input: {
  userId?: string;
  momentId?: string;
  transactionId?: string;
}): Promise<AuditMomentPurchaseResult> {
  const query: Record<string, unknown> = {};
  if (input.userId) query.userId = input.userId;
  if (input.momentId) query.mediaId = input.momentId;
  if (input.transactionId) query.transactionId = input.transactionId;

  const purchase = Object.keys(query).length
    ? await MomentPurchase.findOne(query).lean()
    : null;

  const momentId = input.momentId ?? purchase?.mediaId?.toString();
  const userId = input.userId ?? purchase?.userId?.toString();
  const txnId = input.transactionId ?? purchase?.transactionId;

  const moment = momentId ? await CreatorMoment.findById(momentId).lean() : null;

  const buyerLedger = txnId
    ? await CoinTransaction.find({ transactionId: txnId }).lean()
    : userId
      ? await CoinTransaction.find({ userId, source: 'moment_purchase' })
          .sort({ createdAt: -1 })
          .limit(5)
          .lean()
      : [];

  const creatorLedger = txnId
    ? await CoinTransaction.find({ transactionId: `${txnId}_creator` }).lean()
    : [];

  return {
    purchase: purchase as Record<string, unknown> | null,
    moment: moment as Record<string, unknown> | null,
    buyerLedger: buyerLedger as Record<string, unknown>[],
    creatorLedger: creatorLedger as Record<string, unknown>[],
  };
}

export async function regrantMomentEntitlement(input: {
  userId: string;
  momentId: string;
  reason: string;
  ticketId: string;
  actor: string;
  forceRepair?: boolean;
  skipLedger?: boolean;
  dryRun?: boolean;
}): Promise<{ created: boolean; purchaseId?: string }> {
  const cfg = getMomentsConfig();
  const userObjectId = new mongoose.Types.ObjectId(input.userId);
  const momentObjectId = new mongoose.Types.ObjectId(input.momentId);

  const existing = await MomentPurchase.findOne({
    userId: userObjectId,
    mediaId: momentObjectId,
  });
  if (existing && !existing.refundedAt && !input.forceRepair && !input.skipLedger) {
    return { created: false, purchaseId: existing._id.toString() };
  }

  const moment = await CreatorMoment.findById(momentObjectId);
  if (!moment || moment.isDeleted) throw new Error('Moment not found');
  if (moment.accessType !== 'paid') throw new Error('Moment is not paid content');

  const buyer = await User.findById(userObjectId);
  if (!buyer) throw new Error('User not found');

  const creator = await Creator.findById(moment.creatorId);
  if (!creator) throw new Error('Creator not found');
  const creatorUser = await User.findById(creator.userId);
  if (!creatorUser) throw new Error('Creator user not found');

  if (input.dryRun) {
    return { created: true };
  }

  const txnId = `admin_regrant_${input.momentId}_${input.userId}_${randomUUID()}`;
  const gross = moment.priceCoins;
  const creatorShare = Math.floor(gross * cfg.creatorRevenueShare);
  const platformShare = gross - creatorShare;

  const session = await mongoose.startSession();
  try {
    let purchaseId: string | undefined;
    await session.withTransaction(async () => {
      let debitTxId = existing?.ledgerEntryId;
      let creditTxId = existing?.creatorLedgerEntryId;

      if (!input.skipLedger) {
        if (!existing || existing.refundedAt) {
          buyer.coins = (buyer.coins || 0) - gross;
          await buyer.save({ session });
          creatorUser.coins = (creatorUser.coins || 0) + creatorShare;
          creator.earningsCoins = (creator.earningsCoins || 0) + creatorShare;
          await creatorUser.save({ session });
          await creator.save({ session });
        }

        const [debitTx] = await CoinTransaction.create(
          [
            {
              transactionId: txnId,
              userId: buyer._id,
              type: 'debit',
              coins: gross,
              source: 'moment_purchase',
              description: `ADMIN REGRANT ${input.ticketId}: ${input.reason}`,
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
              description: `ADMIN REGRANT earnings ${input.ticketId}`,
              status: 'completed',
            },
          ],
          { session },
        );
        debitTxId = debitTx._id;
        creditTxId = creditTx._id;
      } else if (!debitTxId) {
        throw new Error('skipLedger requires existing ledgerEntryId on purchase row');
      }

      const purchaseObjectId = existing?._id ?? new mongoose.Types.ObjectId();
      const revenueObjectId = existing?.revenueRecordId ?? new mongoose.Types.ObjectId();

      const revenue = input.skipLedger && existing?.revenueRecordId
        ? await MomentRevenue.findById(existing.revenueRecordId).session(session)
        : (
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

      if (existing) {
        existing.refundedAt = undefined;
        existing.transactionId = txnId;
        existing.ledgerEntryId = debitTxId!;
        existing.creatorLedgerEntryId = creditTxId!;
        if (revenue) existing.revenueRecordId = revenue._id;
        existing.amountCoins = gross;
        await existing.save({ session });
        purchaseId = existing._id.toString();
      } else {
        await MomentPurchase.create(
          [
            {
              _id: purchaseObjectId,
              userId: buyer._id,
              mediaId: moment._id,
              amountCoins: gross,
              transactionId: txnId,
              ledgerEntryId: debitTxId!,
              creatorLedgerEntryId: creditTxId ?? null,
              entitlementVersion: cfg.entitlementVersion,
              revenueRecordId: revenue!._id,
            },
          ],
          { session },
        );
        purchaseId = purchaseObjectId.toString();
        if (!input.skipLedger) {
          moment.purchaseCount += 1;
          await moment.save({ session });
        }
      }
    });

    console.log(
      JSON.stringify({
        action: 'moment_purchase_regrant',
        actor: input.actor,
        ticketId: input.ticketId,
        reason: input.reason,
        userId: input.userId,
        momentId: input.momentId,
        purchaseId,
      }),
    );

    return { created: true, purchaseId };
  } finally {
    await session.endSession();
  }
}

export async function refundMomentPurchase(input: {
  purchaseId?: string;
  userId?: string;
  momentId?: string;
  reason: string;
  ticketId: string;
  actor: string;
  dryRun?: boolean;
}): Promise<{ refunded: boolean; purchaseId?: string }> {
  const purchase = input.purchaseId
    ? await MomentPurchase.findById(input.purchaseId)
    : await MomentPurchase.findOne({
        userId: input.userId,
        mediaId: input.momentId,
      });

  if (!purchase) throw new Error('Purchase not found');
  if (purchase.refundedAt) {
    return { refunded: false, purchaseId: purchase._id.toString() };
  }

  const moment = await CreatorMoment.findById(purchase.mediaId);
  if (!moment) throw new Error('Moment not found');

  const buyer = await User.findById(purchase.userId);
  if (!buyer) throw new Error('Buyer not found');

  const creator = await Creator.findById(moment.creatorId);
  if (!creator) throw new Error('Creator not found');
  const creatorUser = await User.findById(creator.userId);
  if (!creatorUser) throw new Error('Creator user not found');

  const revenue = await MomentRevenue.findById(purchase.revenueRecordId);
  const gross = purchase.amountCoins;
  const creatorShare = revenue?.creatorShareCoins ?? Math.floor(gross * getMomentsConfig().creatorRevenueShare);

  if (input.dryRun) {
    return { refunded: true, purchaseId: purchase._id.toString() };
  }

  const refundTxnId = `admin_refund_${purchase._id}_${randomUUID()}`;
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      buyer.coins = (buyer.coins || 0) + gross;
      await buyer.save({ session });

      creatorUser.coins = Math.max(0, (creatorUser.coins || 0) - creatorShare);
      creator.earningsCoins = Math.max(0, (creator.earningsCoins || 0) - creatorShare);
      await creatorUser.save({ session });
      await creator.save({ session });

      await CoinTransaction.create(
        [
          {
            transactionId: refundTxnId,
            userId: buyer._id,
            type: 'credit',
            coins: gross,
            source: 'admin',
            description: `MOMENT REFUND ${input.ticketId}: ${input.reason}`,
            status: 'completed',
          },
        ],
        { session },
      );

      await CoinTransaction.create(
        [
          {
            transactionId: `${refundTxnId}_creator`,
            userId: creatorUser._id,
            type: 'debit',
            coins: creatorShare,
            source: 'admin',
            description: `MOMENT REFUND clawback ${input.ticketId}`,
            status: 'completed',
          },
        ],
        { session },
      );

      purchase.refundedAt = new Date();
      await purchase.save({ session });
    });

    console.log(
      JSON.stringify({
        action: 'moment_purchase_refund',
        actor: input.actor,
        ticketId: input.ticketId,
        reason: input.reason,
        purchaseId: purchase._id.toString(),
      }),
    );

    return { refunded: true, purchaseId: purchase._id.toString() };
  } finally {
    await session.endSession();
  }
}
