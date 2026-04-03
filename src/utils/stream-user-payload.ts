import type { IUser } from '../modules/user/user.model';
import { Creator } from '../modules/creator/creator.model';

/**
 * Resolve display name from user identity fields (username → email → phone).
 */
export const displayNameForUser = (user: {
  username?: string;
  email?: string;
  phone?: string;
}): string =>
  user.username && user.username.trim().length > 0
    ? user.username.trim()
    : user.email && user.email.trim().length > 0
      ? user.email.trim()
      : user.phone && user.phone.trim().length > 0
        ? user.phone.trim()
        : 'User';

/** Display name + avatar for chat UI and call history (same rules as Stream upsert). */
export type ChatPresentation = {
  name: string;
  image?: string;
};

/**
 * Resolve presentation from User + optional Creator row (batch-friendly; no DB calls).
 */
export function resolveChatPresentationFromDocs(
  user: {
    role?: string;
    username?: string;
    email?: string;
    phone?: string;
    avatar?: string;
  },
  creator: { name?: string; photo?: string } | null | undefined,
): ChatPresentation {
  const appRole = user.role || 'user';
  let name = displayNameForUser(user);
  let image: string | undefined = user.avatar?.trim() || undefined;

  if (appRole === 'creator' || appRole === 'admin') {
    if (creator) {
      if (creator.name?.trim()) {
        name = creator.name.trim();
      }
      if (creator.photo?.trim()) {
        image = creator.photo.trim();
      }
    }
  }

  return { name, image };
}

export type StreamUserUpsertInput = {
  name: string;
  image?: string;
  appRole: 'user' | 'creator' | 'admin';
  username?: string;
  mongoId: string;
};

/**
 * Build Stream Chat upsert payload. For creators/admins, prefers public creator name and photo.
 */
export async function getStreamUpsertPayload(user: IUser): Promise<StreamUserUpsertInput> {
  const mongoId = user._id.toString();
  const appRole = (user.role || 'user') as 'user' | 'creator' | 'admin';
  let creatorDoc: { name?: string; photo?: string } | null = null;
  if (appRole === 'creator' || appRole === 'admin') {
    creatorDoc = await Creator.findOne({ userId: user._id })
      .select('name photo')
      .lean<{ name?: string; photo?: string } | null>();
  }
  const { name, image } = resolveChatPresentationFromDocs(user, creatorDoc);

  return {
    name,
    image,
    appRole,
    username: user.username?.trim() || undefined,
    mongoId,
  };
}
