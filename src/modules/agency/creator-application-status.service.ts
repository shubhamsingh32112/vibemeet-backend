import type { Types } from 'mongoose';
import { User } from '../user/user.model';
import { Creator } from '../creator/creator.model';
import { isAgencyRole } from '../../utils/staff-roles';

export type CreatorApplicationFlags = {
  creatorApplicationPending: boolean;
  creatorApplicationRejected: boolean;
  creatorApplicationRejectionReason?: string;
  /** Approved agency referral — user must complete host profile in the app. */
  hostProfileSetupRequired: boolean;
};

/**
 * Agency referral host onboarding — surfaced to Flutter as creatorApplication* and hostProfileSetupRequired.
 */
export async function getCreatorApplicationFlagsForUser(
  userId: Types.ObjectId
): Promise<CreatorApplicationFlags> {
  const u = await User.findById(userId)
    .select('hostOnboardingStatus hostOnboardingRejectedReason referredBy')
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

  let hostProfileSetupRequired = false;
  if (st === 'approved' && u.referredBy) {
    const refUser = await User.findById(u.referredBy).select('role').lean();
    if (refUser && isAgencyRole(refUser.role)) {
      const existingCreator = await Creator.findOne({ userId }).select('_id').lean();
      hostProfileSetupRequired = !existingCreator;
    }
  }

  return {
    creatorApplicationPending: pending,
    creatorApplicationRejected: rejected,
    hostProfileSetupRequired,
    ...(rejected && u.hostOnboardingRejectedReason
      ? { creatorApplicationRejectionReason: u.hostOnboardingRejectedReason }
      : {}),
  };
}
