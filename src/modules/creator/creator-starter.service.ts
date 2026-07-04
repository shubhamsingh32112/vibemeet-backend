import type { ClientSession } from 'mongoose';
import mongoose from 'mongoose';
import type { IUser } from '../user/user.model';
import { Creator, type ICreator } from './creator.model';
import { CoinTransaction } from '../user/coin-transaction.model';
import { getSystemDefaultHostPriceForNewHosts } from '../../config/host-price.config';

export const STARTER_CREATOR_ABOUT =
  'Complete your creator profile in the app to start connecting with fans.';
/** @deprecated Prefer `getSystemDefaultHostPriceForNewHosts()` for new host rows. */
export const DEFAULT_CREATOR_STARTER_PRICE = 60;

export function creatorPromotionWalletClearTransactionId(userId: string): string {
  return `creator_promotion_wallet_clear_${userId}`;
}

async function getCompletedLedgerBalance(
  userId: mongoose.Types.ObjectId,
  session?: ClientSession
): Promise<number> {
  const pipeline = [
    {
      $match: {
        userId: new mongoose.Types.ObjectId(userId.toString()),
        status: 'completed',
      },
    },
    {
      $group: {
        _id: '$type',
        total: { $sum: '$coins' },
      },
    },
  ];

  const agg = session
    ? await CoinTransaction.aggregate(pipeline).session(session)
    : await CoinTransaction.aggregate(pipeline);

  const credits = agg.find((a: { _id: string; total: number }) => a._id === 'credit')?.total || 0;
  const debits = agg.find((a: { _id: string; total: number }) => a._id === 'debit')?.total || 0;
  return credits - debits;
}

/**
 * After promotion sets User.coins = 0, write one ledger entry so credits − debits nets to 0.
 * Debits surplus balance; credits a deficit (e.g. legacy fixed −30 reversal).
 * Idempotent via deterministic transactionId.
 */
export async function ensureCreatorPromotionWalletClearedEntry(
  user: IUser,
  session?: ClientSession
): Promise<void> {
  const transactionId = creatorPromotionWalletClearTransactionId(user._id.toString());

  const existingQuery = CoinTransaction.findOne({ transactionId }).select('_id');
  const existing = session
    ? await existingQuery.session(session).lean()
    : await existingQuery.lean();
  if (existing) {
    return;
  }

  const ledgerBalance = await getCompletedLedgerBalance(user._id, session);
  if (ledgerBalance === 0) {
    return;
  }

  const type: 'credit' | 'debit' = ledgerBalance > 0 ? 'debit' : 'credit';
  const coins = Math.abs(ledgerBalance);
  const description =
    type === 'debit'
      ? 'Consumer wallet cleared on creator promotion'
      : 'Ledger correction on creator promotion';

  await CoinTransaction.updateOne(
    { transactionId },
    {
      $setOnInsert: {
        userId: user._id,
        type,
        coins,
        source: 'admin',
        description,
        status: 'completed',
      },
    },
    { upsert: true, session }
  );
}

export function starterCreatorDisplayName(user: IUser): string {
  const raw =
    user.username?.trim() ||
    (user.email ? user.email.split('@')[0] : '') ||
    user.phone?.trim() ||
    'Creator';
  const s = raw.replace(/\s+/g, ' ').trim() || 'Creator';
  return s.length > 100 ? s.slice(0, 100) : s;
}

// `creator.photo` was removed in Phase E of the Cloudflare migration. A
// freshly-promoted creator inherits whatever avatar the user already has
// (Cloudflare IImageAsset). Display fallbacks happen on the client.

/**
 * Sets creator role + coin rules (aligned with admin promote), creates minimal Creator doc.
 * Caller must run inside a transaction session when atomicity is required.
 */
export async function promoteUserToCreatorWithStarterProfile(
  user: IUser,
  options: {
    assignedAgencyId?: import('mongoose').Types.ObjectId | null;
    session?: ClientSession;
  }
): Promise<ICreator> {
  const session = options.session;
  const previousCoins = user.coins || 0;
  user.coins = 0;
  user.role = 'creator';
  await user.save({ session });
  await ensureCreatorPromotionWalletClearedEntry(user, session);

  if (previousCoins > 0) {
    // eslint-disable-next-line no-console
    console.log(
      `[creator-starter] Cleared ${previousCoins} coins for user ${user._id} (starter creator profile)`
    );
  }

  const doc = {
    name: starterCreatorDisplayName(user),
    about: STARTER_CREATOR_ABOUT,
    avatar: user.avatar ?? null,
    userId: user._id,
    ...(user.firebaseUid ? { firebaseUid: user.firebaseUid.trim() } : {}),
    categories: [] as string[],
    price: getSystemDefaultHostPriceForNewHosts(),
    ...(options.assignedAgencyId
      ? { assignedAgencyId: options.assignedAgencyId }
      : {}),
  };

  const created = await Creator.create([doc], { session });
  return created[0];
}
