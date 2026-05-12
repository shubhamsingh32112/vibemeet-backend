import mongoose from 'mongoose';
import { CommissionProfile } from './commission-profile.model';
import { getOrCreatePlatformRevenueConfig } from './platform-revenue-config.model';
import { logWarning } from '../../utils/logger';

/** Mongo sort aligned with deterministic tie-break (see docs/commission-profile-resolution.md). */
export const COMMISSION_PROFILE_RESOLUTION_SORT = {
  priority: -1,
  validFrom: -1,
  createdAt: -1,
  _id: -1,
} as const;

function activeProfileFilter(subjectId: mongoose.Types.ObjectId, scope: 'bd' | 'agency', now: Date) {
  return {
    scope,
    subjectId,
    validFrom: { $lte: now },
    $or: [{ validTo: null }, { validTo: { $gte: now } }],
  };
}

/**
 * When multiple profiles are active with the same priority, resolution is still deterministic
 * but operators should dedupe overlaps — log once per resolution path.
 */
function logAmbiguousSamePriority(
  scope: 'bd' | 'agency',
  subjectId: mongoose.Types.ObjectId,
  profiles: { _id: unknown; priority: number }[]
): void {
  if (profiles.length < 2) return;
  const p0 = profiles[0].priority;
  if (profiles[1].priority !== p0) return;
  logWarning('CommissionProfile ambiguous overlap (same priority; resolver used tie-break)', {
    scope,
    subjectId: subjectId.toString(),
    priority: p0,
    candidateIds: profiles.map((x) => String(x._id)),
  });
}

/**
 * Resolve BD/agency basis points for settlement.
 *
 * Order: active BD CommissionProfile → else active agency CommissionProfile → else PlatformRevenueConfig (global).
 */
export async function resolveStaffCommissionBps(params: {
  bdUserId: mongoose.Types.ObjectId;
  agencyId?: mongoose.Types.ObjectId | null;
}): Promise<{ bdBps: number; agencyBps: number }> {
  const now = new Date();

  const bdCandidates = await CommissionProfile.find(activeProfileFilter(params.bdUserId, 'bd', now))
    .sort(COMMISSION_PROFILE_RESOLUTION_SORT)
    .limit(5)
    .select('bdBps agencyBps priority _id')
    .lean();

  if (bdCandidates.length > 0) {
    logAmbiguousSamePriority('bd', params.bdUserId, bdCandidates);
    const bdProfile = bdCandidates[0];
    return { bdBps: bdProfile.bdBps, agencyBps: bdProfile.agencyBps };
  }

  if (params.agencyId) {
    const agencyCandidates = await CommissionProfile.find(
      activeProfileFilter(params.agencyId, 'agency', now)
    )
      .sort(COMMISSION_PROFILE_RESOLUTION_SORT)
      .limit(5)
      .select('bdBps agencyBps priority _id')
      .lean();

    if (agencyCandidates.length > 0) {
      logAmbiguousSamePriority('agency', params.agencyId, agencyCandidates);
      const agencyProfile = agencyCandidates[0];
      return { bdBps: agencyProfile.bdBps, agencyBps: agencyProfile.agencyBps };
    }
  }

  const g = await getOrCreatePlatformRevenueConfig();
  return { bdBps: g.bdBps, agencyBps: g.agencyBps };
}
