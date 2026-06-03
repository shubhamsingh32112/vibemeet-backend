import type { Types } from 'mongoose';
import { CreatorFollow } from '../models/creator-follow.model';
import type { FeedDTO } from '../dto/moment.dto';

export async function loadFollowedCreatorIds(
  userId: Types.ObjectId | null | undefined,
): Promise<Set<string>> {
  if (!userId) return new Set();
  const follows = await CreatorFollow.find({ followerUserId: userId }).select('creatorId');
  return new Set(follows.map((f) => f.creatorId.toString()));
}

export function applyIsFollowingToFeed(
  items: FeedDTO[],
  followedCreatorIds: Set<string>,
): FeedDTO[] {
  return items.map((item) => ({
    ...item,
    isFollowing: followedCreatorIds.has(item.creatorId),
  }));
}

export async function countCreatorFollowers(creatorId: Types.ObjectId | string): Promise<number> {
  return CreatorFollow.countDocuments({ creatorId });
}

export async function countCreatorFollowing(
  followerUserId: Types.ObjectId | string,
): Promise<number> {
  return CreatorFollow.countDocuments({ followerUserId });
}

export async function isUserFollowingCreator(
  followerUserId: Types.ObjectId,
  creatorId: Types.ObjectId | string,
): Promise<boolean> {
  const row = await CreatorFollow.findOne({ followerUserId, creatorId });
  return Boolean(row);
}
