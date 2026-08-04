import mongoose from 'mongoose';
import { DevicePushToken, PushPlatform } from './device-push-token.model';

export async function upsertDevicePushToken(input: {
  userId: mongoose.Types.ObjectId;
  token: string;
  platform: PushPlatform;
}): Promise<void> {
  await DevicePushToken.findOneAndUpdate(
    { token: input.token },
    {
      $set: {
        userId: input.userId,
        platform: input.platform,
      },
      $setOnInsert: {
        token: input.token,
      },
    },
    { upsert: true, new: true }
  );
}

export async function deleteDevicePushToken(input: {
  userId: mongoose.Types.ObjectId;
  token: string;
}): Promise<void> {
  await DevicePushToken.deleteOne({
    userId: input.userId,
    token: input.token,
  });
}

export async function deleteAllPushTokensForUser(
  userId: mongoose.Types.ObjectId
): Promise<void> {
  await DevicePushToken.deleteMany({ userId });
}

export async function listTokensForUserIds(
  userIds: mongoose.Types.ObjectId[]
): Promise<Array<{ userId: mongoose.Types.ObjectId; token: string }>> {
  if (userIds.length === 0) return [];
  const rows = await DevicePushToken.find({ userId: { $in: userIds } })
    .select('userId token')
    .lean();
  return rows.map((r) => ({
    userId: r.userId as mongoose.Types.ObjectId,
    token: r.token,
  }));
}

export async function pruneInvalidTokens(tokens: string[]): Promise<number> {
  if (tokens.length === 0) return 0;
  const result = await DevicePushToken.deleteMany({ token: { $in: tokens } });
  return result.deletedCount ?? 0;
}
