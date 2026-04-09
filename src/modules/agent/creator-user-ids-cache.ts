import mongoose from 'mongoose';
import { Creator } from '../creator/creator.model';

const TTL_MS = 60_000;

let cache: { ids: mongoose.Types.ObjectId[]; expiresAt: number } | null = null;

/**
 * Cached Creator.userId list for agent promote-user search ($nin filter).
 * TTL tradeoff: a new creator row may be missing from exclusion briefly — acceptable for this flow.
 */
export async function getCachedCreatorUserObjectIds(): Promise<mongoose.Types.ObjectId[]> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) {
    return cache.ids;
  }
  const raw = await Creator.distinct('userId');
  const ids = raw.map((id) => new mongoose.Types.ObjectId(String(id)));
  cache = { ids, expiresAt: now + TTL_MS };
  return ids;
}
