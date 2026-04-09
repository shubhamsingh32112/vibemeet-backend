import type { Types } from 'mongoose';

export type CreatorApplicationFlags = {
  creatorApplicationPending: boolean;
  creatorApplicationRejected: boolean;
  creatorApplicationRejectionReason?: string;
};

/**
 * Legacy CreatorApplication workflow is retired: agent referrals no longer create pending
 * applications. Clients still receive these flags for backward compatibility; they are always
 * false so the app does not block on verification screens.
 */
export async function getCreatorApplicationFlagsForUser(
  _userId: Types.ObjectId
): Promise<CreatorApplicationFlags> {
  return {
    creatorApplicationPending: false,
    creatorApplicationRejected: false,
  };
}
