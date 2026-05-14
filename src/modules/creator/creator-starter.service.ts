import type { ClientSession } from 'mongoose';
import type { IUser } from '../user/user.model';
import { Creator, type ICreator } from './creator.model';
import { CoinTransaction } from '../user/coin-transaction.model';
import { getSystemDefaultHostPriceForNewHosts } from '../../config/host-price.config';

export const STARTER_CREATOR_ABOUT =
  'Complete your creator profile in the app to start connecting with fans.';
/** @deprecated Prefer `getSystemDefaultHostPriceForNewHosts()` for new host rows. */
export const DEFAULT_CREATOR_STARTER_PRICE = 60;
export const CREATOR_PROMOTION_BONUS_REVERSAL_COINS = 30;

export function creatorPromotionBonusReversalTransactionId(userId: string): string {
  return `creator_promotion_bonus_reversal_${userId}`;
}

export async function ensureCreatorPromotionBonusReversalEntry(
  user: IUser,
  session?: ClientSession
): Promise<void> {
  await CoinTransaction.updateOne(
    { transactionId: creatorPromotionBonusReversalTransactionId(user._id.toString()) },
    {
      $setOnInsert: {
        userId: user._id,
        type: 'debit',
        coins: CREATOR_PROMOTION_BONUS_REVERSAL_COINS,
        source: 'admin',
        description: 'Welcome bonus reversal on creator promotion (-30 coins)',
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
  await ensureCreatorPromotionBonusReversalEntry(user, session);

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
