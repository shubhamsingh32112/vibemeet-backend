import type { Types } from 'mongoose';
import { User } from '../user/user.model';
export type CreatorApplicationFlags = {
  creatorApplicationPending: boolean;
  creatorApplicationRejected: boolean;
  creatorApplicationRejectionReason?: string;
  /** Deprecated — always false; agency approval promotes directly to creator. */
  hostProfileSetupRequired: boolean;
};

/**
 * Agency referral host onboarding — surfaced to Flutter as creatorApplication* and hostProfileSetupRequired.
 */
export async function getCreatorApplicationFlagsForUser(
  userId: Types.ObjectId
): Promise<CreatorApplicationFlags> {
  const u = await User.findById(userId)
    .select('hostOnboardingStatus hostOnboardingRejectedReason')
    .lean();
  if (!u) {
    return {
      creatorApplicationPending: false,
      creatorApplicationRejected: false,
      hostProfileSetupRequired: false,
    };
  }
  const statusRaw = String(u.hostOnboardingStatus ?? 'none');
  const pending =
    statusRaw === 'pending_agency_approval' ||
    statusRaw === 'pending_bd_approval' ||
    statusRaw === 'under_review';
  const st = u.hostOnboardingStatus ?? 'none';
  const rejected =
    st === 'rejected' || st === 'suspended' || st === 'blocked';

  return {
    creatorApplicationPending: pending,
    creatorApplicationRejected: rejected,
    hostProfileSetupRequired: false,
    ...(rejected && u.hostOnboardingRejectedReason
      ? { creatorApplicationRejectionReason: u.hostOnboardingRejectedReason }
      : {}),
  };
}
