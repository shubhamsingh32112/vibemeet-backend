import type { Types } from 'mongoose';
import { Creator } from '../../creator/creator.model';
import { buildAvatarUrls } from '../../images/image-url';
import type { PreviewCreatorMeta } from './free-preview.service';

export interface CreatorMeta {
  name: string;
  avatarUrl?: string;
  firebaseUid?: string;
}

export async function resolveCreatorsMeta(
  creatorIds: Types.ObjectId[],
): Promise<Map<string, CreatorMeta>> {
  const unique = [...new Set(creatorIds.map((id) => id.toString()))];
  const map = new Map<string, CreatorMeta>();
  if (unique.length === 0) return map;

  const creators = await Creator.find({ _id: { $in: unique } })
    .select('name avatar firebaseUid')
    .lean();
  for (const creator of creators) {
    const avatarUrl = creator.avatar?.imageId
      ? buildAvatarUrls(creator.avatar.imageId).sm
      : undefined;
    const firebaseUid =
      creator.firebaseUid && String(creator.firebaseUid).trim() !== ''
        ? String(creator.firebaseUid).trim()
        : undefined;
    map.set(creator._id.toString(), { name: creator.name, avatarUrl, firebaseUid });
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
  return {
    id: creator._id.toString(),
    name: creator.name,
    avatarUrl,
    verified: false,
  };
}
