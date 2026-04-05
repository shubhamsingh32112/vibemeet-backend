import type { Types } from 'mongoose';
import { CreatorApplication } from './creator-application.model';

export type CreatorApplicationFlags = {
  creatorApplicationPending: boolean;
  creatorApplicationRejected: boolean;
  creatorApplicationRejectionReason?: string;
};

export async function getCreatorApplicationFlagsForUser(
  userId: Types.ObjectId
): Promise<CreatorApplicationFlags> {
  const pending = await CreatorApplication.findOne({
    applicantUserId: userId,
    status: 'pending',
  })
    .select('_id')
    .lean();

  if (pending) {
    return {
      creatorApplicationPending: true,
      creatorApplicationRejected: false,
    };
  }

  const rejected = await CreatorApplication.findOne({
    applicantUserId: userId,
    status: 'rejected',
  })
    .sort({ resolvedAt: -1, updatedAt: -1 })
    .select('rejectionReason')
    .lean();

  if (rejected) {
    return {
      creatorApplicationPending: false,
      creatorApplicationRejected: true,
      creatorApplicationRejectionReason: rejected.rejectionReason || undefined,
    };
  }

  return {
    creatorApplicationPending: false,
    creatorApplicationRejected: false,
  };
}
