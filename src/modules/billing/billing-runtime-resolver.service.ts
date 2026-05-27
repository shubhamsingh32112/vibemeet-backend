import {
  getRedis,
  CALL_SESSION_PREFIX,
  callSessionKey,
  activeCallByUserKey,
  callUserIntroMicrosKey,
  callUserWalletMicrosKey,
  callUserCoinsKey,
  callCreatorEarningsKey,
} from '../../config/redis';
import { getBillingCheckpoint } from './billing-checkpoint.service';
import { BILLING_PROCESS_INTERVAL_MS, BILLING_SESSION_SCHEMA_VERSION } from './billing.constants';
import { recordBillingMetric } from '../../utils/monitoring';
import { BillingLifecycleState } from './billing-lifecycle.machine';

export interface BillingRuntimeSession {
  schemaVersion?: number;
  callId: string;
  userFirebaseUid: string;
  creatorFirebaseUid: string;
  userMongoId: string;
  creatorMongoId: string;
  pricePerMinute: number;
  pricePerSecondMicros?: number;
  creatorEarningsPerSecondMicros?: number;
  startTime: number;
  lastProcessedAt?: number;
  totalDeductedMicros?: number;
  totalEarnedMicros?: number;
  billingSequence?: number;
  lifecycleState?: BillingLifecycleState;
  elapsedSeconds: number;
  effectiveDurationLimitSeconds?: number;
  version?: number;
}

export interface ResolvedBillingRuntime {
  source: 'redis' | 'checkpoint' | 'reconstructed' | 'missing';
  session: BillingRuntimeSession | null;
  balanceMicros: number;
  introMicros: number;
  walletMicros: number;
  earningsMicros: number;
}

export interface ResolvedUserActiveRuntime {
  callId: string | null;
  runtime: ResolvedBillingRuntime;
  source: 'slot' | 'scan' | 'none';
}

function buildSessionFromCheckpoint(
  checkpoint: Record<string, unknown>,
  callId: string
): BillingRuntimeSession | null {
  const userMongoId = String(checkpoint.userMongoId || '');
  const creatorMongoId = String(checkpoint.creatorMongoId || '');
  const userFirebaseUid = String(checkpoint.userFirebaseUid || '');
  const creatorFirebaseUid = String(checkpoint.creatorFirebaseUid || '');
  if (!userMongoId || !creatorMongoId || !userFirebaseUid || !creatorFirebaseUid) {
    return null;
  }
  const startTimeMs = Number(checkpoint.startTimeMs) || Date.now();
  const lastProcessedAtMs = Number(checkpoint.lastProcessedAtMs) || startTimeMs;
  const pricePerSecondMicros = Math.max(0, Number(checkpoint.pricePerSecondMicros) || 0);
  const totalDeductedMicros = Math.max(0, Number(checkpoint.totalDeductedMicros) || 0);
  const elapsedSeconds =
    pricePerSecondMicros > 0 ? Math.floor(totalDeductedMicros / pricePerSecondMicros) : 0;

  return {
    schemaVersion: BILLING_SESSION_SCHEMA_VERSION,
    callId,
    userFirebaseUid,
    creatorFirebaseUid,
    userMongoId,
    creatorMongoId,
    pricePerMinute:
      pricePerSecondMicros > 0 ? Math.round((pricePerSecondMicros * 60) / 1_000_000) : 0,
    pricePerSecondMicros,
    creatorEarningsPerSecondMicros: Math.max(
      0,
      Number(checkpoint.creatorEarningsPerSecondMicros) || 0
    ),
    startTime: startTimeMs,
    lastProcessedAt: lastProcessedAtMs,
    totalDeductedMicros,
    totalEarnedMicros: Math.max(0, Number(checkpoint.totalEarnedMicros) || 0),
    billingSequence: Math.max(0, Number(checkpoint.billingSequence) || 0),
    lifecycleState: (checkpoint.lifecycleState as BillingLifecycleState) || 'RECOVERING',
    elapsedSeconds,
    effectiveDurationLimitSeconds: Number(checkpoint.effectiveDurationLimitSeconds) || undefined,
    version: Math.max(1, Number(checkpoint.version) || 1),
  };
}

export async function resolveBillingRuntimeState(callId: string): Promise<ResolvedBillingRuntime> {
  const redis = getRedis();
  const sessionRaw = await redis.get(callSessionKey(callId));
  if (sessionRaw) {
    const session = JSON.parse(sessionRaw) as BillingRuntimeSession;
    const [introR, walletR, legacyMerged, earningsRaw] = await Promise.all([
      redis.get(callUserIntroMicrosKey(callId)),
      redis.get(callUserWalletMicrosKey(callId)),
      redis.get(callUserCoinsKey(callId)),
      redis.get(callCreatorEarningsKey(callId)),
    ]);
    let introMicros = Math.max(0, parseInt(String(introR ?? '0'), 10) || 0);
    let walletMicros = Math.max(0, parseInt(String(walletR ?? '0'), 10) || 0);
    if (introR === null && walletR === null && legacyMerged !== null && legacyMerged !== undefined) {
      walletMicros = Math.max(0, parseInt(String(legacyMerged), 10) || 0);
      introMicros = 0;
    }
    const earningsMicros = Math.max(0, parseInt(String(earningsRaw ?? '0'), 10) || 0);
    recordBillingMetric('billing_recovery_source', 1, { source: 'redis', callId });
    recordBillingMetric('billing_reconnect_replay_count', 1, { source: 'redis', callId });
    return {
      source: 'redis',
      session,
      introMicros,
      walletMicros,
      balanceMicros: introMicros + walletMicros,
      earningsMicros,
    };
  }

  const checkpoint = (await getBillingCheckpoint(callId)) as Record<string, unknown> | null;
  if (!checkpoint) {
    recordBillingMetric('billing_recovery_source', 1, { source: 'missing', callId });
    return {
      source: 'missing',
      session: null,
      introMicros: 0,
      walletMicros: 0,
      balanceMicros: 0,
      earningsMicros: 0,
    };
  }

  const session = buildSessionFromCheckpoint(checkpoint, callId);
  if (!session) {
    recordBillingMetric('billing_recovery_source', 1, { source: 'missing', callId });
    return {
      source: 'missing',
      session: null,
      introMicros: 0,
      walletMicros: 0,
      balanceMicros: 0,
      earningsMicros: 0,
    };
  }

  const balanceMicros = Math.max(0, Number(checkpoint.remainingUserBalanceMicros) || 0);
  const earningsMicros = Math.max(0, Number(checkpoint.totalEarnedMicros) || 0);
  await redis
    .multi()
    .setex(callSessionKey(callId), 7200, JSON.stringify(session))
    .setex(callUserIntroMicrosKey(callId), 7200, '0')
    .setex(callUserWalletMicrosKey(callId), 7200, String(balanceMicros))
    .setex(callCreatorEarningsKey(callId), 7200, String(earningsMicros))
    .exec();

  await redis.setex(
    callSessionKey(callId),
    7200,
    JSON.stringify({
      ...session,
      expectedNextTickAtMs: (session.lastProcessedAt || Date.now()) + BILLING_PROCESS_INTERVAL_MS,
    })
  );

  recordBillingMetric('billing_recovery_source', 1, { source: 'checkpoint', callId });
  recordBillingMetric('billing_reconstruction_count', 1, { source: 'checkpoint', callId });
  recordBillingMetric('billing_checkpoint_fallback_count', 1, { callId });
  recordBillingMetric('billing_reconnect_replay_count', 1, { source: 'checkpoint', callId });
  return {
    source: 'checkpoint',
    session,
    introMicros: 0,
    walletMicros: balanceMicros,
    balanceMicros,
    earningsMicros,
  };
}

export async function resolveActiveRuntimeStateForUser(
  firebaseUid: string
): Promise<ResolvedUserActiveRuntime> {
  const redis = getRedis();
  const slotCallId = await redis.get(activeCallByUserKey(firebaseUid));
  if (slotCallId) {
    const runtime = await resolveBillingRuntimeState(slotCallId);
    if (runtime.session) {
      recordBillingMetric('billing_recovery_active_user_lookup', 1, {
        source: 'slot',
        firebaseUid,
      });
      return {
        callId: slotCallId,
        runtime,
        source: 'slot',
      };
    }
    await redis.del(activeCallByUserKey(firebaseUid)).catch(() => {});
  }

  let cursor = '0';
  const scanLimit = 2000;
  let scanned = 0;
  do {
    const [next, keys] = await redis.scan(
      cursor,
      'MATCH',
      `${CALL_SESSION_PREFIX}*`,
      'COUNT',
      '200'
    );
    cursor = next;
    for (const key of keys) {
      if (scanned >= scanLimit) break;
      scanned += 1;
      const callId = key.replace(CALL_SESSION_PREFIX, '');
      if (!callId) continue;
      const runtime = await resolveBillingRuntimeState(callId);
      const session = runtime.session;
      if (!session) continue;
      if (session.userFirebaseUid !== firebaseUid && session.creatorFirebaseUid !== firebaseUid) {
        continue;
      }
      await redis
        .setex(activeCallByUserKey(firebaseUid), 7200, callId)
        .catch(() => {});
      recordBillingMetric('billing_recovery_active_user_lookup', 1, {
        source: 'scan',
        firebaseUid,
      });
      return {
        callId,
        runtime,
        source: 'scan',
      };
    }
  } while (cursor !== '0' && scanned < scanLimit);

  recordBillingMetric('billing_recovery_active_user_lookup', 1, {
    source: 'none',
    firebaseUid,
  });
  return {
    callId: null,
    runtime: {
      source: 'missing',
      session: null,
      introMicros: 0,
      walletMicros: 0,
      balanceMicros: 0,
      earningsMicros: 0,
    },
    source: 'none',
  };
}

