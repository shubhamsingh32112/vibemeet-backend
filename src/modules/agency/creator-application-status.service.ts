import type { Types } from 'mongoose';
import { User } from '../user/user.model';

export type CreatorApplicationFlags = {
  creatorApplicationPending: boolean;
  creatorApplicationRejected: boolean;
  creatorApplicationRejectionReason?: string;
};

/**
 * BD referral host onboarding — surfaced to Flutter as legacy creatorApplication* flags.
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
    };
  }
  const st = u.hostOnboardingStatus ?? 'none';
  const pending = st === 'pending_agency_approval' || st === 'under_review';
  const rejected =
    st === 'rejected' || st === 'suspended' || st === 'blocked';
  return {
    creatorApplicationPending: pending,
    creatorApplicationRejected: rejected,
    ...(rejected && u.hostOnboardingRejectedReason
      ? { creatorApplicationRejectionReason: u.hostOnboardingRejectedReason }
      : {}),
  };
}
