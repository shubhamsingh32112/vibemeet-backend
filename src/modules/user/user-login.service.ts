import type { IUser } from './user.model';
import { User } from './user.model';
import { UserLoginEvent } from './user-login-event.model';

export type AuthClientPlatform = 'web' | 'mobile' | 'unknown';
export type AuthEventKind = 'interactive_login' | 'session_restore' | 'legacy_auth_sync';

export type AuthAnalyticsClaims = {
  clientPlatform: AuthClientPlatform;
  eventKind: AuthEventKind;
  clientEventId?: string;
};

function isDuplicateKeyError(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { code?: number }).code === 11000;
}

export function normalizeAuthAnalyticsClaims(body: unknown): AuthAnalyticsClaims {
  const record = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const clientPlatform: AuthClientPlatform =
    record.clientPlatform === 'web' || record.clientPlatform === 'mobile'
      ? record.clientPlatform
      : 'unknown';
  const eventKind: AuthEventKind =
    record.eventKind === 'interactive_login' || record.eventKind === 'session_restore'
      ? record.eventKind
      : 'legacy_auth_sync';
  const rawId = typeof record.clientEventId === 'string' ? record.clientEventId.trim() : '';
  const clientEventId =
    rawId.length >= 8 && rawId.length <= 128 && /^[A-Za-z0-9._:-]+$/.test(rawId)
      ? rawId
      : undefined;
  return { clientPlatform, eventKind, clientEventId };
}

/**
 * Classify an existing consumer on its first observed website auth sync.
 * The compare-and-set cannot overwrite a concurrent winning web creation.
 */
export async function observeExistingWebsiteUser(
  userId: IUser['_id'],
  observedAt: Date,
): Promise<void> {
  await User.updateOne(
    {
      _id: userId,
      role: 'user',
      websiteAudienceCategory: { $exists: false },
    },
    {
      $set: {
        websiteAudienceCategory: 'preexisting_then_website',
        websiteAudienceSince: observedAt,
        firstWebsiteLoginAt: observedAt,
      },
    },
  );
  await User.updateOne(
    { _id: userId, role: 'user' },
    { $max: { lastWebsiteLoginAt: observedAt } },
  );
}

/** Record a consumer auth synchronization for admin analytics (role=user only). */
export async function recordConsumerUserLogin(
  user: Pick<IUser, '_id' | 'role'>,
  input: AuthAnalyticsClaims & { accountCreated: boolean; observedAt: Date },
): Promise<Date | null> {
  if (user.role !== 'user') return null;
  const event = {
    userId: user._id,
    role: user.role,
    clientPlatform: input.clientPlatform,
    accountCreated: input.accountCreated,
    eventKind: input.eventKind,
    clientEventId: input.clientEventId,
    loggedInAt: input.observedAt,
  };
  if (input.clientEventId) {
    let stored;
    try {
      stored = await UserLoginEvent.findOneAndUpdate(
        { clientEventId: input.clientEventId },
        { $setOnInsert: event },
        { upsert: true, new: true },
      );
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
      stored = await UserLoginEvent.findOne({ clientEventId: input.clientEventId });
    }
    if (!stored || stored.userId.toString() !== user._id.toString()) {
      throw new Error('clientEventId collision');
    }
    return stored.loggedInAt;
  }
  await UserLoginEvent.create(event);
  return input.observedAt;
}
