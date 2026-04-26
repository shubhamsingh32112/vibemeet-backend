import { User, type IUser } from './user.model';
import { featureFlags } from '../../config/feature-flags';

export type PermissionStatus = 'unknown' | 'granted' | 'denied' | 'permanentlyDenied';
export type PermissionsDecision = 'accept' | 'not_now';
export type OnboardingStageCanonical = 'welcome' | 'bonus' | 'permissions' | 'completed';
export type OnboardingStageInput =
  | OnboardingStageCanonical
  | 'permission';
export type OnboardingStrictMode = 'log-only' | 'soft-enforce' | 'hard-enforce';
export type OnboardingTransitionEvent =
  | 'welcome_seen'
  | 'bonus_seen'
  | 'permissions_not_now'
  | 'permissions_accept';

type TransitionResult = {
  user: IUser;
  fromStage: OnboardingStageCanonical;
  toStage: OnboardingStageCanonical;
  ignored: boolean;
  idempotentReplay?: boolean;
  invalidTransition?: boolean;
  invalidReason?: string;
  metrics: {
    invalidTransition: boolean;
    idempotentReplay: boolean;
    success: boolean;
    atomicConflictReplay: boolean;
  };
};

const allowedTransitions: Record<OnboardingStageCanonical, OnboardingStageCanonical[]> = {
  welcome: ['bonus'],
  bonus: ['permissions'],
  permissions: ['completed'],
  completed: [],
};

function stageRank(stage: OnboardingStageCanonical): number {
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

function getStrictMode(): OnboardingStrictMode {
  const raw = String(featureFlags.onboardingStrictMode ?? 'log-only').trim().toLowerCase();
  if (raw === 'soft-enforce' || raw === 'hard-enforce') return raw;
  return 'log-only';
}

export function toNextStageFromEvent(event: OnboardingTransitionEvent): OnboardingStageCanonical {
  if (event === 'welcome_seen') return 'bonus';
  if (event === 'bonus_seen') return 'permissions';
  if (event === 'permissions_accept') return 'completed';
  return 'permissions';
}

export function isAllowedTransition(fromStage: OnboardingStageCanonical, toStage: OnboardingStageCanonical): boolean {
  if (fromStage === toStage) return true;
  return allowedTransitions[fromStage]?.includes(toStage) ?? false;
}

function shouldRejectTransition(mode: OnboardingStrictMode): boolean {
  return mode === 'hard-enforce';
}

function shouldIgnoreInvalidTransition(mode: OnboardingStrictMode): boolean {
  return mode === 'soft-enforce';
}

function buildCompletionUpdate(
  fromStage: OnboardingStageCanonical,
  toStage: OnboardingStageCanonical,
  now: Date
) {
  const set: Record<string, unknown> = {
    onboardingStage: toStage,
  };
  const setOnInsert = {
    onboardingStage: toStage,
  };

  // Timestamp semantics are completion-driven by transition edge.
  if (fromStage === 'welcome' && toStage === 'bonus') {
    set.onboardingWelcomeSeenAt = now;
  }
  if (fromStage === 'bonus' && toStage === 'permissions') {
    set.onboardingBonusSeenAt = now;
  }
  if (fromStage === 'permissions' && toStage === 'completed') {
    set.onboardingCompletedAt = now;
  }

  return { $set: set, $setOnInsert: setOnInsert };
}

export function stageForClient(stage: string | undefined | null): string {
  return canonicalizeStage(stage) === 'permissions' ? 'permission' : canonicalizeStage(stage);
}

export async function applyOnboardingStageEvent(params: {
  firebaseUid: string;
  event: OnboardingTransitionEvent;
  idempotencyKey?: string;
}): Promise<TransitionResult> {
  const { firebaseUid, event, idempotencyKey } = params;
  const mode = getStrictMode();
  const user = await User.findOne({ firebaseUid });
  if (!user) {
    throw new Error('USER_NOT_FOUND');
  }

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
  const toStage = toNextStageFromEvent(event);
  const fromRank = stageRank(fromStage);
  const toRank = stageRank(toStage);

  // Monotonic enforcement: never allow regressions.
  if (toRank < fromRank) {
    const invalidReason = `regression:${fromStage}->${toStage}`;
    console.warn(
      `[ONBOARDING_TRANSITION] mode=${mode} uid=${firebaseUid} event=${event} ${invalidReason}`
    );
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

  // Equal-rank handling: only allow true idempotent replay (requires idempotency key).
  if (toRank === fromRank && fromStage === toStage && !idempotencyKey) {
    const invalidReason = `equal_rank_without_idempotency:${fromStage}`;
    console.warn(
      `[ONBOARDING_TRANSITION] mode=${mode} uid=${firebaseUid} event=${event} ${invalidReason}`
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
  }
  const valid = isAllowedTransition(fromStage, toStage);
  if (!valid) {
    const invalidReason = `invalid_transition:${fromStage}->${toStage}`;
    console.warn(
      `[ONBOARDING_TRANSITION] mode=${mode} uid=${firebaseUid} event=${event} ${invalidReason}`
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
  const updateDoc = buildCompletionUpdate(fromStage, toStage, now);
  if (idempotencyKey) {
    (updateDoc.$set as Record<string, unknown>).lastOnboardingStageIdempotencyKey =
      idempotencyKey;
  }
  const updated = await User.findOneAndUpdate(
    {
      firebaseUid,
      onboardingStage: { $in: [fromStage, fromStage === 'permissions' ? 'permission' : fromStage] },
      ...(idempotencyKey
        ? { lastOnboardingStageIdempotencyKey: { $ne: idempotencyKey } }
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
    `[ONBOARDING_TRANSITION] uid=${firebaseUid} event=${event} from=${fromStage} to=${toStage} result=success`
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
}): Promise<TransitionResult> {
  const { firebaseUid, decision, requestId, cameraMicStatus, notificationStatus } = params;
  const mode = getStrictMode();
  const user = await User.findOne({ firebaseUid });
  if (!user) {
    throw new Error('USER_NOT_FOUND');
  }

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

  // Reconciliation safety: if onboarding is already completed, only update fields.
  // Do NOT apply stage transitions in this mode.
  if (fromStage === 'completed') {
    const now = new Date();
    const set: Record<string, unknown> = {
      lastPermissionsDecisionRequestId: requestId,
      permissionsLastCheckedAt: now,
    };
    if (cameraMicStatus) {
      set.cameraMicPermissionStatus = cameraMicStatus;
    }
    if (notificationStatus) {
      set.notificationPermissionStatus = notificationStatus;
    }
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
  const targetStage = toNextStageFromEvent(event);
  const valid = isAllowedTransition(fromStage, targetStage);
  if (!valid) {
    const invalidReason = `invalid_transition:${fromStage}->${targetStage}`;
    console.warn(
      `[ONBOARDING_TRANSITION] mode=${mode} uid=${firebaseUid} event=${event} ${invalidReason}`
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
  if (cameraMicStatus) {
    set.cameraMicPermissionStatus = cameraMicStatus;
  }
  if (notificationStatus) {
    set.notificationPermissionStatus = notificationStatus;
  }

  let toStage = fromStage;
  if (fromStage !== targetStage && valid) {
    toStage = targetStage;
    set.onboardingStage = targetStage;
    if (targetStage === 'completed' && !user.onboardingCompletedAt) {
      set.onboardingCompletedAt = now;
    }
  }

  const updated = await User.findOneAndUpdate(
    {
      firebaseUid,
      onboardingStage: { $in: [fromStage, fromStage === 'permissions' ? 'permission' : fromStage] },
      lastPermissionsDecisionRequestId: { $ne: requestId },
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
    `[ONBOARDING_PERMISSION_DECISION] uid=${firebaseUid} decision=${decision} requestId=${requestId} from=${fromStage} to=${toStage} result=success`
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
