import { User, type IUser } from './user.model';
import { featureFlags } from '../../config/feature-flags';

export type PermissionStatus = 'unknown' | 'granted' | 'denied' | 'permanentlyDenied';
export type PermissionsDecision = 'accept' | 'not_now';
export type OnboardingStageCanonical = 'welcome' | 'bonus' | 'permissions' | 'completed';
export type OnboardingStageInput =
  | OnboardingStageCanonical
  | 'permission';
export type OnboardingStrictMode = 'log-only' | 'soft-enforce' | 'hard-enforce';
export type OnboardingFlowVersion = 1 | 2;
export type OnboardingTransitionEvent =
  | 'welcome_seen'
  | 'bonus_seen'
  | 'permissions_not_now'
  | 'permissions_accept';

export type RolloutFastForwardGuard = 'permission_seen_at' | 'legacy_client';

type TransitionResult = {
  user: IUser;
  fromStage: OnboardingStageCanonical;
  toStage: OnboardingStageCanonical;
  ignored: boolean;
  idempotentReplay?: boolean;
  invalidTransition?: boolean;
  invalidReason?: string;
  rolloutFastForward?: boolean;
  metrics: {
    invalidTransition: boolean;
    idempotentReplay: boolean;
    success: boolean;
    atomicConflictReplay: boolean;
  };
};

const V1_ALLOWED: Record<OnboardingStageCanonical, OnboardingStageCanonical[]> = {
  welcome: ['bonus'],
  bonus: ['permissions'],
  permissions: ['completed'],
  completed: [],
};

const V2_ALLOWED: Record<OnboardingStageCanonical, OnboardingStageCanonical[]> = {
  welcome: ['permissions'],
  bonus: ['permissions'],
  permissions: ['completed'],
  completed: [],
};

function stageRank(stage: OnboardingStageCanonical, flowVersion: OnboardingFlowVersion): number {
  if (flowVersion === 1) {
    if (stage === 'welcome') return 1;
    if (stage === 'bonus') return 2;
    if (stage === 'permissions') return 3;
    return 4;
  }
  if (stage === 'welcome') return 1;
  if (stage === 'bonus') return 2;
  if (stage === 'permissions') return 3;
  return 4;
}

export function canonicalizeStage(stage?: string | null): OnboardingStageCanonical {
  if (stage === 'permission' || stage === 'permissions') return 'permissions';
  if (stage === 'bonus' || stage === 'completed' || stage === 'welcome') {
    return stage;
  }
  return 'welcome';
}

export function resolveEffectiveFlowVersion(
  userVersion: number | undefined | null,
  requestVersion?: number | null
): OnboardingFlowVersion {
  const u: OnboardingFlowVersion = userVersion === 2 ? 2 : 1;
  const r: OnboardingFlowVersion = requestVersion === 2 ? 2 : 1;
  return u >= r ? u : r;
}

export function getUserFlowVersion(user: IUser): OnboardingFlowVersion {
  return user.onboardingFlowVersion === 2 ? 2 : 1;
}

function getAllowedTransitions(
  flowVersion: OnboardingFlowVersion
): Record<OnboardingStageCanonical, OnboardingStageCanonical[]> {
  return flowVersion === 2 ? V2_ALLOWED : V1_ALLOWED;
}

function getStrictMode(): OnboardingStrictMode {
  const raw = String(featureFlags.onboardingStrictMode ?? 'log-only').trim().toLowerCase();
  if (raw === 'soft-enforce' || raw === 'hard-enforce') return raw;
  return 'log-only';
}

export function toNextStageFromEvent(
  event: OnboardingTransitionEvent,
  flowVersion: OnboardingFlowVersion = 1
): OnboardingStageCanonical {
  if (event === 'welcome_seen') {
    return flowVersion === 2 ? 'permissions' : 'bonus';
  }
  if (event === 'bonus_seen') return 'permissions';
  if (event === 'permissions_accept') return 'completed';
  return 'permissions';
}

export function isAllowedTransition(
  fromStage: OnboardingStageCanonical,
  toStage: OnboardingStageCanonical,
  flowVersion: OnboardingFlowVersion = 1
): boolean {
  if (fromStage === toStage) return true;
  return getAllowedTransitions(flowVersion)[fromStage]?.includes(toStage) ?? false;
}

function parseSemverParts(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function semverLt(clientVersion: string, minVersion: string): boolean {
  const a = parseSemverParts(clientVersion);
  const b = parseSemverParts(minVersion);
  if (!a || !b) return false;
  if (a[0] !== b[0]) return a[0] < b[0];
  if (a[1] !== b[1]) return a[1] < b[1];
  return a[2] < b[2];
}

function getRolloutDeadline(): Date | null {
  const raw = String(
    process.env.ONBOARDING_FAST_FORWARD_UNTIL ??
      featureFlags.onboardingFastForwardUntil ??
      ''
  ).trim();
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function mayRolloutFastForward(params: {
  event: OnboardingTransitionEvent;
  fromStage: OnboardingStageCanonical;
  user: IUser;
  clientAppVersion?: string;
  now?: Date;
}): { allowed: boolean; guard?: RolloutFastForwardGuard } {
  const { event, fromStage, user, clientAppVersion } = params;
  const now = params.now ?? new Date();

  if (event !== 'permissions_accept') return { allowed: false };
  if (fromStage !== 'welcome' && fromStage !== 'bonus') return { allowed: false };

  const deadline = getRolloutDeadline();
  if (!deadline || now > deadline) return { allowed: false };

  if (user.onboardingPermissionSeenAt) {
    return { allowed: true, guard: 'permission_seen_at' };
  }

  const minFixed = String(
    process.env.MIN_FIXED_CLIENT_VERSION ??
      featureFlags.onboardingMinFixedClientVersion ??
      ''
  ).trim();
  if (clientAppVersion && minFixed && semverLt(clientAppVersion, minFixed)) {
    return { allowed: true, guard: 'legacy_client' };
  }

  return { allowed: false };
}

function shouldRejectTransition(mode: OnboardingStrictMode): boolean {
  return mode === 'hard-enforce';
}

function shouldIgnoreInvalidTransition(mode: OnboardingStrictMode): boolean {
  return mode === 'soft-enforce';
}

function invalidTransitionResult(
  user: IUser,
  fromStage: OnboardingStageCanonical,
  invalidReason: string,
  mode: OnboardingStrictMode
): TransitionResult {
  console.warn(
    `[ONBOARDING_TRANSITION] mode=${mode} uid=${user.firebaseUid} ${invalidReason}`
  );
  if (shouldRejectTransition(mode)) {
    return {
      user,
      fromStage,
      toStage: fromStage,
      ignored: false,
      invalidTransition: true,
      invalidReason,
      metrics: {
        invalidTransition: true,
        idempotentReplay: false,
        success: false,
        atomicConflictReplay: false,
      },
    };
  }
  if (shouldIgnoreInvalidTransition(mode)) {
    return {
      user,
      fromStage,
      toStage: fromStage,
      ignored: true,
      invalidTransition: true,
      invalidReason,
      metrics: {
        invalidTransition: true,
        idempotentReplay: false,
        success: false,
        atomicConflictReplay: false,
      },
    };
  }
  return {
    user,
    fromStage,
    toStage: fromStage,
    ignored: true,
    invalidTransition: true,
    invalidReason,
    metrics: {
      invalidTransition: true,
      idempotentReplay: false,
      success: false,
      atomicConflictReplay: false,
    },
  };
}

/** Exported for contract tests; Mongo forbids overlapping $set / $setOnInsert paths. */
export function buildCompletionUpdate(
  fromStage: OnboardingStageCanonical,
  toStage: OnboardingStageCanonical,
  now: Date,
  flowVersion: OnboardingFlowVersion = 1
) {
  const set: Record<string, unknown> = {
    onboardingStage: toStage,
  };

  if (flowVersion === 2) {
    if (fromStage === 'welcome' && toStage === 'permissions') {
      set.onboardingWelcomeSeenAt = now;
    }
    if (fromStage === 'bonus' && toStage === 'permissions') {
      set.onboardingBonusSeenAt = now;
    }
    if (fromStage === 'permissions' && toStage === 'completed') {
      set.onboardingCompletedAt = now;
    }
    return { $set: set };
  }

  if (fromStage === 'welcome' && toStage === 'bonus') {
    set.onboardingWelcomeSeenAt = now;
  }
  if (fromStage === 'bonus' && toStage === 'permissions') {
    set.onboardingBonusSeenAt = now;
  }
  if (fromStage === 'permissions' && toStage === 'completed') {
    set.onboardingCompletedAt = now;
  }

  return { $set: set };
}

export function stageForClient(stage: string | undefined | null): string {
  return canonicalizeStage(stage) === 'permissions' ? 'permission' : canonicalizeStage(stage);
}

function checkTransitionMutationDedup(
  user: IUser,
  clientMutationId?: string
): TransitionResult | null {
  if (!clientMutationId || clientMutationId.length === 0) return null;
  if (user.lastOnboardingTransitionRequestId !== clientMutationId) return null;
  const fromStage = canonicalizeStage(user.onboardingStage);
  console.log(
    `[ONBOARDING_TRANSITION] uid=${user.firebaseUid} clientMutationId=${clientMutationId} result=mutation_idempotent_replay`
  );
  return {
    user,
    fromStage,
    toStage: fromStage,
    ignored: true,
    idempotentReplay: true,
    metrics: {
      invalidTransition: false,
      idempotentReplay: true,
      success: false,
      atomicConflictReplay: false,
    },
  };
}

export async function applyOnboardingStageEvent(params: {
  firebaseUid: string;
  event: OnboardingTransitionEvent;
  idempotencyKey?: string;
  clientMutationId?: string;
  requestFlowVersion?: number | null;
  clientAppVersion?: string;
}): Promise<TransitionResult> {
  const {
    firebaseUid,
    event,
    idempotencyKey,
    clientMutationId,
    requestFlowVersion,
  } = params;
  const mode = getStrictMode();
  const user = await User.findOne({ firebaseUid });
  if (!user) {
    throw new Error('USER_NOT_FOUND');
  }

  const mutationReplay = checkTransitionMutationDedup(user, clientMutationId);
  if (mutationReplay) return mutationReplay;

  const flowVersion = resolveEffectiveFlowVersion(
    user.onboardingFlowVersion,
    requestFlowVersion
  );

  const fromStage = canonicalizeStage(user.onboardingStage);
  if (idempotencyKey && user.lastOnboardingStageIdempotencyKey === idempotencyKey) {
    return {
      user,
      fromStage,
      toStage: fromStage,
      ignored: true,
      idempotentReplay: true,
      metrics: {
        invalidTransition: false,
        idempotentReplay: true,
        success: false,
        atomicConflictReplay: false,
      },
    };
  }
  const toStage = toNextStageFromEvent(event, flowVersion);
  const fromRank = stageRank(fromStage, flowVersion);
  const toRank = stageRank(toStage, flowVersion);

  if (toRank < fromRank) {
    return invalidTransitionResult(
      user,
      fromStage,
      `regression:${fromStage}->${toStage}`,
      mode
    );
  }

  if (toRank === fromRank && fromStage === toStage && !idempotencyKey) {
    return invalidTransitionResult(
      user,
      fromStage,
      `equal_rank_without_idempotency:${fromStage}`,
      mode
    );
  }

  const valid = isAllowedTransition(fromStage, toStage, flowVersion);
  if (!valid) {
    return invalidTransitionResult(
      user,
      fromStage,
      `invalid_transition:${fromStage}->${toStage}`,
      mode
    );
  }

  if (fromStage === toStage) {
    console.log(
      `[ONBOARDING_TRANSITION] uid=${firebaseUid} event=${event} from=${fromStage} to=${toStage} result=idempotent_replay`
    );
    return {
      user,
      fromStage,
      toStage,
      ignored: true,
      idempotentReplay: true,
      metrics: {
        invalidTransition: false,
        idempotentReplay: true,
        success: false,
        atomicConflictReplay: false,
      },
    };
  }

  const now = new Date();
  const updateDoc = buildCompletionUpdate(fromStage, toStage, now, flowVersion);
  const setFields = updateDoc.$set as Record<string, unknown>;
  if (idempotencyKey) {
    setFields.lastOnboardingStageIdempotencyKey = idempotencyKey;
  }
  if (clientMutationId) {
    setFields.lastOnboardingTransitionRequestId = clientMutationId;
  }
  if (flowVersion === 2 && user.onboardingFlowVersion !== 2) {
    setFields.onboardingFlowVersion = 2;
  }

  const updated = await User.findOneAndUpdate(
    {
      firebaseUid,
      onboardingStage: { $in: [fromStage, fromStage === 'permissions' ? 'permission' : fromStage] },
      ...(idempotencyKey
        ? { lastOnboardingStageIdempotencyKey: { $ne: idempotencyKey } }
        : {}),
      ...(clientMutationId
        ? {
            $or: [
              { lastOnboardingTransitionRequestId: { $exists: false } },
              { lastOnboardingTransitionRequestId: null },
              { lastOnboardingTransitionRequestId: { $ne: clientMutationId } },
            ],
          }
        : {}),
    },
    updateDoc,
    { new: true }
  );
  if (!updated) {
    const latest = await User.findOne({ firebaseUid });
    if (!latest) {
      throw new Error('USER_NOT_FOUND');
    }
    console.log(
      `[ONBOARDING_TRANSITION] uid=${firebaseUid} event=${event} from=${fromStage} to=${canonicalizeStage(latest.onboardingStage)} result=conflict_replay`
    );
    return {
      user: latest,
      fromStage: canonicalizeStage(latest.onboardingStage),
      toStage: canonicalizeStage(latest.onboardingStage),
      ignored: true,
      idempotentReplay: true,
      metrics: {
        invalidTransition: false,
        idempotentReplay: true,
        success: false,
        atomicConflictReplay: true,
      },
    };
  }

  console.log(
    `[ONBOARDING_TRANSITION] uid=${firebaseUid} event=${event} flowVersion=${flowVersion} from=${fromStage} to=${toStage} result=success`
  );
  return {
    user: updated,
    fromStage,
    toStage,
    ignored: false,
    metrics: {
      invalidTransition: false,
      idempotentReplay: false,
      success: true,
      atomicConflictReplay: false,
    },
  };
}

export async function submitPermissionsDecisionEvent(params: {
  firebaseUid: string;
  decision: PermissionsDecision;
  requestId: string;
  cameraMicStatus?: PermissionStatus;
  notificationStatus?: PermissionStatus;
  clientMutationId?: string;
  requestFlowVersion?: number | null;
  clientAppVersion?: string;
}): Promise<TransitionResult> {
  const {
    firebaseUid,
    decision,
    requestId,
    cameraMicStatus,
    notificationStatus,
    clientMutationId,
    requestFlowVersion,
    clientAppVersion,
  } = params;
  const mode = getStrictMode();
  const user = await User.findOne({ firebaseUid });
  if (!user) {
    throw new Error('USER_NOT_FOUND');
  }

  const mutationReplay = checkTransitionMutationDedup(user, clientMutationId);
  if (mutationReplay) return mutationReplay;

  const flowVersion = resolveEffectiveFlowVersion(
    user.onboardingFlowVersion,
    requestFlowVersion
  );

  if (user.lastPermissionsDecisionRequestId === requestId) {
    console.log(
      `[ONBOARDING_PERMISSION_DECISION] uid=${firebaseUid} decision=${decision} requestId=${requestId} result=idempotent_replay`
    );
    return {
      user,
      fromStage: canonicalizeStage(user.onboardingStage),
      toStage: canonicalizeStage(user.onboardingStage),
      ignored: true,
      idempotentReplay: true,
      metrics: {
        invalidTransition: false,
        idempotentReplay: true,
        success: false,
        atomicConflictReplay: false,
      },
    };
  }

  const fromStage = canonicalizeStage(user.onboardingStage);

  if (fromStage === 'completed') {
    const now = new Date();
    const set: Record<string, unknown> = {
      lastPermissionsDecisionRequestId: requestId,
      permissionsLastCheckedAt: now,
    };
    if (cameraMicStatus) set.cameraMicPermissionStatus = cameraMicStatus;
    if (notificationStatus) set.notificationPermissionStatus = notificationStatus;
    if (clientMutationId) set.lastOnboardingTransitionRequestId = clientMutationId;

    const updated = await User.findOneAndUpdate(
      {
        firebaseUid,
        onboardingStage: { $in: ['completed'] },
        lastPermissionsDecisionRequestId: { $ne: requestId },
      },
      { $set: set },
      { new: true }
    );
    const latest = updated ?? (await User.findOne({ firebaseUid }));
    if (!latest) {
      throw new Error('USER_NOT_FOUND');
    }
    console.log(
      `[ONBOARDING_PERMISSION_RECONCILE] uid=${firebaseUid} requestId=${requestId} result=${
        updated ? 'success' : 'conflict_replay'
      }`
    );
    return {
      user: latest,
      fromStage: 'completed',
      toStage: 'completed',
      ignored: !updated,
      idempotentReplay: !updated,
      metrics: {
        invalidTransition: false,
        idempotentReplay: !updated,
        success: Boolean(updated),
        atomicConflictReplay: !updated,
      },
    };
  }

  const event: OnboardingTransitionEvent =
    decision === 'accept' ? 'permissions_accept' : 'permissions_not_now';
  const targetStage = toNextStageFromEvent(event, flowVersion);
  let valid = isAllowedTransition(fromStage, targetStage, flowVersion);
  let rolloutFastForward = false;
  let fastForwardGuard: RolloutFastForwardGuard | undefined;

  if (!valid && event === 'permissions_accept') {
    const ff = mayRolloutFastForward({
      event,
      fromStage,
      user,
      clientAppVersion,
    });
    if (ff.allowed) {
      valid = true;
      rolloutFastForward = true;
      fastForwardGuard = ff.guard;
    }
  }

  if (!valid) {
    const invalidReason = `invalid_transition:${fromStage}->${targetStage}`;
    console.warn(
      `[ONBOARDING_TRANSITION] mode=${mode} uid=${firebaseUid} event=${event} ${invalidReason}`
    );
    return invalidTransitionResult(user, fromStage, invalidReason, mode);
  }

  const now = new Date();
  const set: Record<string, unknown> = {
    lastPermissionsDecisionRequestId: requestId,
    onboardingPermissionSeenAt: user.onboardingPermissionSeenAt ?? now,
    permissionsLastCheckedAt: now,
  };
  if (decision === 'accept' && !user.permissionsIntroAcceptedAt) {
    set.permissionsIntroAcceptedAt = now;
    set.permissionOnboardingStatus = 'accepted';
  }
  if (decision === 'not_now') {
    set.permissionOnboardingStatus = 'skipped';
  }
  if (cameraMicStatus) set.cameraMicPermissionStatus = cameraMicStatus;
  if (notificationStatus) set.notificationPermissionStatus = notificationStatus;
  if (clientMutationId) set.lastOnboardingTransitionRequestId = clientMutationId;
  if (flowVersion === 2 && user.onboardingFlowVersion !== 2) {
    set.onboardingFlowVersion = 2;
  }

  let toStage: OnboardingStageCanonical = fromStage;
  if (rolloutFastForward && event === 'permissions_accept') {
    toStage = 'completed';
    set.onboardingStage = 'completed';
    if (!user.onboardingPermissionSeenAt) {
      set.onboardingPermissionSeenAt = now;
    }
    if (!user.onboardingCompletedAt) {
      set.onboardingCompletedAt = now;
    }
    if (fromStage === 'welcome' && !user.onboardingWelcomeSeenAt) {
      set.onboardingWelcomeSeenAt = now;
    }
    if (fromStage === 'bonus' && !user.onboardingBonusSeenAt) {
      set.onboardingBonusSeenAt = now;
    }
    console.log(
      `📊 [ONBOARDING METRIC] rollout_fast_forward_used value=1 userId=${user._id.toString()} guard=${fastForwardGuard ?? 'unknown'} from=${fromStage}`
    );
    console.log(
      `[ONBOARDING_TRANSITION] rollout_fast_forward=true uid=${firebaseUid} from=${fromStage} to=completed guard=${fastForwardGuard ?? 'unknown'} clientAppVersion=${clientAppVersion ?? 'none'}`
    );
  } else if (fromStage !== targetStage) {
    toStage = targetStage;
    set.onboardingStage = targetStage;
    if (targetStage === 'permissions' && fromStage === 'welcome' && !user.onboardingWelcomeSeenAt) {
      set.onboardingWelcomeSeenAt = now;
    }
    if (targetStage === 'permissions' && fromStage === 'bonus' && !user.onboardingBonusSeenAt) {
      set.onboardingBonusSeenAt = now;
    }
    if (targetStage === 'completed' && !user.onboardingCompletedAt) {
      set.onboardingCompletedAt = now;
    }
  }

  const updated = await User.findOneAndUpdate(
    {
      firebaseUid,
      onboardingStage: { $in: [fromStage, fromStage === 'permissions' ? 'permission' : fromStage] },
      lastPermissionsDecisionRequestId: { $ne: requestId },
      ...(clientMutationId
        ? {
            $or: [
              { lastOnboardingTransitionRequestId: { $exists: false } },
              { lastOnboardingTransitionRequestId: null },
              { lastOnboardingTransitionRequestId: { $ne: clientMutationId } },
            ],
          }
        : {}),
    },
    { $set: set },
    { new: true }
  );
  if (!updated) {
    const latest = await User.findOne({ firebaseUid });
    if (!latest) {
      throw new Error('USER_NOT_FOUND');
    }
    console.log(
      `[ONBOARDING_PERMISSION_DECISION] uid=${firebaseUid} decision=${decision} requestId=${requestId} result=conflict_replay`
    );
    return {
      user: latest,
      fromStage: canonicalizeStage(latest.onboardingStage),
      toStage: canonicalizeStage(latest.onboardingStage),
      ignored: true,
      idempotentReplay: latest.lastPermissionsDecisionRequestId === requestId,
      metrics: {
        invalidTransition: false,
        idempotentReplay: latest.lastPermissionsDecisionRequestId === requestId,
        success: false,
        atomicConflictReplay: true,
      },
    };
  }

  console.log(
    `[ONBOARDING_PERMISSION_DECISION] uid=${firebaseUid} decision=${decision} requestId=${requestId} flowVersion=${flowVersion} from=${fromStage} to=${toStage} result=success rolloutFastForward=${rolloutFastForward}`
  );
  return {
    user: updated,
    fromStage,
    toStage,
    ignored: false,
    rolloutFastForward,
    metrics: {
      invalidTransition: false,
      idempotentReplay: false,
      success: true,
      atomicConflictReplay: false,
    },
  };
}
