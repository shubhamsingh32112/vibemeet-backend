import type { IUser } from '../modules/user/user.model';
import { Creator } from '../modules/creator/creator.model';
import type { IImageAsset } from '../modules/images/image-asset.schema';
import { buildAvatarUrls } from '../modules/images/image-url';
import { serializeAvatar, type AvatarSerialization } from '../modules/images/serialize-image-asset';

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
  /** Cloudflare avatar payload (variants + blurhash + dims). */
  avatarAsset?: AvatarSerialization | null;
};

type ResolvableUser = {
  role?: string;
  username?: string;
  email?: string;
  phone?: string;
  avatar?: IImageAsset | null;
};

type ResolvableCreator = {
  name?: string;
  avatar?: IImageAsset | null;
};

/**
 * For Stream Chat we ship avatarMd (256px). Returns null when no avatar.
 */
function pickAvatarUrl(asset: IImageAsset | null | undefined): string | null {
  if (!asset || !asset.imageId) return null;
  try {
    return buildAvatarUrls(asset.imageId).md;
  } catch {
    return null;
  }
}

/**
 * Resolve presentation from User + optional Creator row (batch-friendly; no DB calls).
 */
export function resolveChatPresentationFromDocs(
  user: ResolvableUser,
  creator: ResolvableCreator | null | undefined,
): ChatPresentation {
  const appRole = user.role || 'user';
  let name = displayNameForUser(user);

  let image: string | undefined;
  let avatarAsset: AvatarSerialization | null = null;
  if (user.avatar) {
    image = pickAvatarUrl(user.avatar) ?? undefined;
    avatarAsset = serializeAvatar(user.avatar);
  }

  if (appRole === 'creator' || appRole === 'admin') {
    if (creator) {
      if (creator.name?.trim()) {
        name = creator.name.trim();
      }
      const creatorAvatarUrl = pickAvatarUrl(creator.avatar);
      if (creatorAvatarUrl) {
        image = creatorAvatarUrl;
        avatarAsset = serializeAvatar(creator.avatar ?? null);
      }
    }
  }

  return { name, image, avatarAsset };
}

export type StreamUserUpsertInput = {
  name: string;
  image?: string;
  appRole: 'user' | 'creator' | 'admin';
  username?: string;
  mongoId: string;
};

/**
 * Build Stream Chat upsert payload. For creators/admins, prefers public creator name and avatar.
 */
export async function getStreamUpsertPayload(user: IUser): Promise<StreamUserUpsertInput> {
  const mongoId = user._id.toString();
  const appRole = (user.role || 'user') as 'user' | 'creator' | 'admin';
  let creatorDoc: { name?: string; avatar?: IImageAsset | null } | null = null;
  if (appRole === 'creator' || appRole === 'admin') {
    creatorDoc = await Creator.findOne({ userId: user._id })
      .select('name avatar')
      .lean<{ name?: string; avatar?: IImageAsset | null } | null>();
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
