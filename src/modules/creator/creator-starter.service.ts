import type { ClientSession } from 'mongoose';
import type { IUser } from '../user/user.model';
import { Creator, type ICreator } from './creator.model';

export const STARTER_CREATOR_ABOUT =
  'Complete your creator profile in the app to start connecting with fans.';
export const DEFAULT_CREATOR_STARTER_PRICE = 60;

export function starterCreatorDisplayName(user: IUser): string {
  const raw =
    user.username?.trim() ||
    (user.email ? user.email.split('@')[0] : '') ||
    user.phone?.trim() ||
    'Creator';
  const s = raw.replace(/\s+/g, ' ').trim() || 'Creator';
  return s.length > 100 ? s.slice(0, 100) : s;
}

function starterCreatorPhotoUrl(user: IUser): string {
  const a = user.avatar?.trim();
  if (a && /^https?:\/\//i.test(a)) return a;
  const name = encodeURIComponent(starterCreatorDisplayName(user));
  return `https://ui-avatars.com/api/?name=${name}&size=256&background=6366f1&color=fff`;
}

/**
 * Sets creator role + coin rules (aligned with admin promote), creates minimal Creator doc.
 * Caller must run inside a transaction session when atomicity is required.
 */
export async function promoteUserToCreatorWithStarterProfile(
  user: IUser,
  options: {
    assignedAgentId?: import('mongoose').Types.ObjectId | null;
    session?: ClientSession;
  }
): Promise<ICreator> {
  const session = options.session;
  const previousCoins = user.coins || 0;
  user.welcomeBonusClaimed = true;
  user.coins = 0;
  user.role = 'creator';
  await user.save({ session });

  if (previousCoins > 0) {
    // eslint-disable-next-line no-console
    console.log(
      `[creator-starter] Cleared ${previousCoins} coins for user ${user._id} (starter creator profile)`
    );
  }

  const doc = {
    name: starterCreatorDisplayName(user),
    about: STARTER_CREATOR_ABOUT,
    photo: starterCreatorPhotoUrl(user),
    userId: user._id,
    categories: [] as string[],
    price: DEFAULT_CREATOR_STARTER_PRICE,
    ...(options.assignedAgentId
      ? { assignedAgentId: options.assignedAgentId }
      : {}),
  };

  const created = await Creator.create([doc], { session });
  return created[0];
}
