import { Server } from 'socket.io';
import {
  getRedis,
  callSessionKey,
  callUserIntroMicrosKey,
  callUserWalletMicrosKey,
} from '../../config/redis';
import { pricingService } from '../video/pricing.service';
import { upsertBillingCheckpointSnapshot } from './billing-checkpoint.service';
import {
  CallSession,
  ensureBillingStartedReplayFreshness,
  needsFullSessionBootstrap,
  normalizeV4SessionFields,
  promoteBootstrappingSession,
} from './billing.service';
import { logBillingHealth, logBillingHealthWarn } from './billing-health-log';

const CALL_SESSION_TTL = 7200;

type PromoteBootstrapFailureReason =
  | 'user_not_found'
  | 'creator_not_found'
  | 'invalid_participants'
  | 'insufficient_coins'
  | 'concurrent_promote'
  | 'redis_error';

export type SessionPricingRepairResult = {
  repaired: boolean;
  reason:
    | 'already_valid'
    | 'pricing_patched'
    | 'bootstrap_completed'
    | 'creator_not_found'
    | 'user_not_found'
    | 'still_bootstrapping'
    | 'invalid_participants'
    | 'insufficient_coins'
    | 'concurrent_promote'
    | 'redis_error';
  pricePerSecondMicros?: number;
};

function sessionPricePerSecondMicros(session: CallSession): number {
  return Math.max(
    0,
    Number(session.billingPricePerSecondMicros ?? session.pricePerSecondMicros) || 0
  );
}

async function patchSessionPricingOnly(
  callId: string,
  session: CallSession,
  source: string
): Promise<SessionPricingRepairResult> {
  const creatorMongoId = String(session.creatorMongoId || '').trim();
  if (!creatorMongoId) {
    return { repaired: false, reason: 'creator_not_found' };
  }

  let pricing;
  try {
    pricing = await pricingService.snapshotForCreatorCached(creatorMongoId);
  } catch {
    return { repaired: false, reason: 'creator_not_found' };
  }

  if (pricing.pricePerSecondMicros <= 0) {
    return { repaired: false, reason: 'still_bootstrapping' };
  }

  session.pricePerMinute = pricing.pricePerMinute;
  session.pricePerSecondMicros = pricing.pricePerSecondMicros;
  session.billingPricePerSecondMicros = pricing.pricePerSecondMicros;
  session.creatorEarningsPerSecondMicros = pricing.creatorEarningsPerSecondMicros;
  session.creatorShareAtCallTime = pricing.creatorShareAtCallTime;
  normalizeV4SessionFields(session);

  const redis = getRedis();
  await redis.setex(callSessionKey(callId), CALL_SESSION_TTL, JSON.stringify(session));

  const [introRaw, walletRaw] = await Promise.all([
    redis.get(callUserIntroMicrosKey(callId)),
    redis.get(callUserWalletMicrosKey(callId)),
  ]);
  const introMicros = Math.max(0, parseInt(String(introRaw ?? '0'), 10) || 0);
  const walletMicros = Math.max(0, parseInt(String(walletRaw ?? '0'), 10) || 0);

  try {
    await upsertBillingCheckpointSnapshot({
      callId,
      userMongoId: session.userMongoId,
      creatorMongoId: session.creatorMongoId,
      userFirebaseUid: session.userFirebaseUid,
      creatorFirebaseUid: session.creatorFirebaseUid,
      startTimeMs: session.startTime,
      lastProcessedAtMs: session.lastProcessedAt,
      remainingUserBalanceMicros: introMicros + walletMicros,
      pricePerSecondMicros: session.pricePerSecondMicros,
      creatorEarningsPerSecondMicros: session.creatorEarningsPerSecondMicros,
      totalDeductedMicros: session.totalDeductedMicros,
      totalEarnedMicros: session.totalEarnedMicros,
      billingSequence: session.billingSequence,
      lifecycleState: session.lifecycleState,
      status: 'active',
    });
  } catch {
    /* non-fatal */
  }

  logBillingHealth('PRICING_REPAIR_DONE', {
    callId,
    source,
    repaired: true,
    reason: 'pricing_patched',
    pricePerSecondMicros: pricing.pricePerSecondMicros,
    pricePerMinute: pricing.pricePerMinute,
  });

  return {
    repaired: true,
    reason: 'pricing_patched',
    pricePerSecondMicros: pricing.pricePerSecondMicros,
  };
}

export async function repairSessionPricingIfNeeded(
  io: Server,
  callId: string,
  session: CallSession,
  source: string
): Promise<SessionPricingRepairResult> {
  const currentPrice = sessionPricePerSecondMicros(session);
  if (currentPrice > 0 && !needsFullSessionBootstrap(session)) {
    return {
      repaired: false,
      reason: 'already_valid',
      pricePerSecondMicros: currentPrice,
    };
  }

  logBillingHealth('PRICING_REPAIR_START', {
    callId,
    source,
    lifecycleState: session.lifecycleState,
    billingSequence: session.billingSequence,
    version: session.version,
    pricePerSecondMicros: currentPrice,
    needsFullBootstrap: needsFullSessionBootstrap(session),
  });

  if (needsFullSessionBootstrap(session)) {
    const redis = getRedis();
    const promoteResult = await promoteBootstrappingSession(
      io,
      redis,
      callId,
      session,
      source,
      {
        terminateOnFailure: false,
        preserveStartTime: true,
        preserveRuntimeBalances: true,
        initiatedByFirebaseUid: session.initiatedByFirebaseUid,
        initiatedByRole: session.initiatedByRole,
      }
    );

    if (!promoteResult.ok) {
      const reasonMap: Record<
        PromoteBootstrapFailureReason,
        SessionPricingRepairResult['reason']
      > = {
        user_not_found: 'user_not_found',
        creator_not_found: 'creator_not_found',
        invalid_participants: 'invalid_participants',
        insufficient_coins: 'insufficient_coins',
        concurrent_promote: 'already_valid',
        redis_error: 'redis_error',
      };

      const mappedReason = reasonMap[promoteResult.reason as PromoteBootstrapFailureReason];
      if (promoteResult.reason === 'concurrent_promote') {
        const liveRaw = await redis.get(callSessionKey(callId));
        if (liveRaw) {
          try {
            const live = JSON.parse(liveRaw) as CallSession;
            const livePrice = sessionPricePerSecondMicros(live);
            if (livePrice > 0) {
              Object.assign(session, live);
              return {
                repaired: false,
                reason: 'already_valid',
                pricePerSecondMicros: livePrice,
              };
            }
          } catch {
            /* fall through */
          }
        }
      }

      logBillingHealthWarn('PRICING_REPAIR_FAILED', {
        callId,
        source,
        reason: mappedReason,
      });
      return { repaired: false, reason: mappedReason };
    }

    Object.assign(session, promoteResult.session);

    await ensureBillingStartedReplayFreshness(io, callId, 'recovery', {
      force: true,
      replayReason: 'pricing_repair_bootstrap',
    }).catch(() => {});

    logBillingHealth('PRICING_REPAIR_DONE', {
      callId,
      source,
      repaired: true,
      reason: 'bootstrap_completed',
      pricePerSecondMicros: promoteResult.pricePerSecondMicros,
      pricePerMinute: promoteResult.session.pricePerMinute,
    });

    return {
      repaired: true,
      reason: 'bootstrap_completed',
      pricePerSecondMicros: promoteResult.pricePerSecondMicros,
    };
  }

  return patchSessionPricingOnly(callId, session, source);
}

export function hasValidSessionPricing(
  repairResult: SessionPricingRepairResult,
  session: CallSession
): boolean {
  if (repairResult.reason === 'already_valid') {
    return true;
  }
  if (repairResult.repaired && (repairResult.pricePerSecondMicros ?? 0) > 0) {
    return true;
  }
  return sessionPricePerSecondMicros(session) > 0;
}
