import type { Types } from 'mongoose';
import { Creator } from '../../creator/creator.model';
import { User } from '../../user/user.model';
import { buildAvatarUrls } from '../../images/image-url';
import type { PreviewCreatorMeta } from './free-preview.service';

export interface CreatorMeta {
  name: string;
  avatarUrl?: string;
  firebaseUid?: string;
}

function isGenericCreatorName(name?: string | null): boolean {
  const trimmed = (name ?? '').trim();
  return !trimmed || trimmed.toLowerCase() === 'creator';
}

function displayNameFromUser(user: {
  username?: string | null;
  displayName?: string | null;
  email?: string | null;
  phone?: string | null;
} | null | undefined): string | undefined {
  if (!user) return undefined;
  const fromUsername = user.username?.trim();
  if (fromUsername) return fromUsername;
  const fromDisplay = user.displayName?.trim();
  if (fromDisplay) return fromDisplay;
  const fromEmail = user.email?.split('@')[0]?.trim();
  if (fromEmail) return fromEmail;
  const fromPhone = user.phone?.trim();
  if (fromPhone) return fromPhone;
  return undefined;
}

export async function resolveCreatorsMeta(
  creatorIds: Types.ObjectId[],
): Promise<Map<string, CreatorMeta>> {
  const unique = [...new Set(creatorIds.map((id) => id.toString()))];
  const map = new Map<string, CreatorMeta>();
  if (unique.length === 0) return map;

  const creators = await Creator.find({ _id: { $in: unique } })
    .select('name avatar firebaseUid userId')
    .lean();

  const needsUserFallback = creators.filter((c) => isGenericCreatorName(c.name) && c.userId);
  const users =
    needsUserFallback.length > 0
      ? await User.find({ _id: { $in: needsUserFallback.map((c) => c.userId) } })
          .select('username displayName email phone')
          .lean()
      : [];
  const userById = new Map(users.map((u) => [u._id.toString(), u] as const));

  for (const creator of creators) {
    const avatarUrl = creator.avatar?.imageId
      ? buildAvatarUrls(creator.avatar.imageId).sm
      : undefined;
    const firebaseUid =
      creator.firebaseUid && String(creator.firebaseUid).trim() !== ''
        ? String(creator.firebaseUid).trim()
        : undefined;
    let name = (creator.name ?? '').trim();
    if (isGenericCreatorName(name) && creator.userId) {
      const user = userById.get(creator.userId.toString());
      name = displayNameFromUser(user) ?? 'Creator';
    } else if (!name) {
      name = 'Creator';
    }
    map.set(creator._id.toString(), { name, avatarUrl, firebaseUid });
  }
  return map;
}

export async function resolveCreatorMetaForMoment(
  creatorId: Types.ObjectId,
): Promise<PreviewCreatorMeta> {
  const creator = await Creator.findById(creatorId).lean();
  if (!creator) {
    return { id: creatorId.toString(), name: 'Creator', verified: false };
  }
  const avatarUrl = creator.avatar?.imageId
    ? buildAvatarUrls(creator.avatar.imageId).sm
    : undefined;

  let name = (creator.name ?? '').trim();
  if (isGenericCreatorName(name) && creator.userId) {
    const user = await User.findById(creator.userId)
      .select('username displayName email phone')
      .lean();
    name = displayNameFromUser(user) ?? 'Creator';
  }
  if (!name) name = 'Creator';

  return {
    id: creator._id.toString(),
    name,
    avatarUrl,
    verified: false,
  };
}
