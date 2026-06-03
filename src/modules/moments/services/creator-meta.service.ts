import type { Types } from 'mongoose';
import { Creator } from '../../creator/creator.model';
import { buildAvatarUrls } from '../../images/image-url';

export interface CreatorMeta {
  name: string;
  avatarUrl?: string;
}

export async function resolveCreatorsMeta(
  creatorIds: Types.ObjectId[],
): Promise<Map<string, CreatorMeta>> {
  const unique = [...new Set(creatorIds.map((id) => id.toString()))];
  const map = new Map<string, CreatorMeta>();
  if (unique.length === 0) return map;

  const creators = await Creator.find({ _id: { $in: unique } }).lean();
  for (const creator of creators) {
    const avatarUrl = creator.avatar?.imageId
      ? buildAvatarUrls(creator.avatar.imageId).sm
      : undefined;
    map.set(creator._id.toString(), { name: creator.name, avatarUrl });
  }
  return map;
}
