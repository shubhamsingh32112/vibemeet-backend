import {
  getRedis,
  CALL_SESSION_PREFIX,
  callSessionKey,
  callSessionTerminalKey,
  parseCallIdFromSessionRedisKey,
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
import { getBillingInstanceId } from './billing-instance-id';
import { logInfo, logWarning, logDebug } from '../../utils/logger';

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
  lastHealthyTickAt?: number;
  lastSocketEmitAt?: number;
  lastSequenceAdvanceAt?: number;
  instanceId?: string;
  runtimeEpoch?: number;
  leaderLock?: string;
}

export interface BillingTerminalSnapshot {
  callId: string;
  lifecycleState: 'SETTLED';
  billingSequence: number;
  elapsedSeconds: number;
  durationSeconds?: number;
  finalCoins?: number;
  totalDeducted?: number;
  totalEarned?: number;
  settledAt: number;
  reason?: string;
  source?: string;
}

export interface ResolvedBillingRuntime {
  source: 'redis' | 'checkpoint' | 'reconstructed' | 'terminal' | 'missing';
  session: BillingRuntimeSession | null;
  balanceMicros: number;
  introMicros: number;
  walletMicros: number;
  earningsMicros: number;
  terminalSnapshot?: BillingTerminalSnapshot;
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
    lastHealthyTickAt: lastProcessedAtMs,
    lastSocketEmitAt: Number(checkpoint.lastCheckpointAtMs) || lastProcessedAtMs,
    lastSequenceAdvanceAt: lastProcessedAtMs,
    instanceId: getBillingInstanceId(),
    runtimeEpoch: Math.max(1, Number(checkpoint.version) || 1),
    leaderLock: `billing:runtime:owner:${callId}`,
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
    logInfo('billing_runtime_resolved', {
      callId,
      source: 'redis',
      lifecycleState: session.lifecycleState,
      billingSequence: session.billingSequence,
      balanceMicros: introMicros + walletMicros,
      elapsedSeconds: session.elapsedSeconds,
    });
    return {
      source: 'redis',
      session,
      introMicros,
      walletMicros,
      balanceMicros: introMicros + walletMicros,
      earningsMicros,
    };
  }

  const terminalRaw = await redis.get(callSessionTerminalKey(callId));
  if (terminalRaw) {
    try {
      const terminalSnapshot = JSON.parse(terminalRaw) as BillingTerminalSnapshot;
      recordBillingMetric('billing_recovery_source', 1, { source: 'terminal', callId });
      recordBillingMetric('billing_resolver_terminal_tombstone_hits', 1, { callId });
      logInfo('billing_runtime_resolved', {
        callId,
        source: 'terminal',
        lifecycleState: terminalSnapshot.lifecycleState,
        billingSequence: terminalSnapshot.billingSequence,
        elapsedSeconds: terminalSnapshot.elapsedSeconds,
      });
      return {
        source: 'terminal',
        session: null,
        introMicros: 0,
        walletMicros: 0,
        balanceMicros: 0,
        earningsMicros: 0,
        terminalSnapshot,
      };
    } catch (error) {
      logWarning('billing_terminal_snapshot_unparseable', { callId, source: 'terminal' });
      recordBillingMetric('billing_recovery_source', 1, {
        source: 'missing',
        callId,
        reason: 'terminal_snapshot_unparseable',
      });
    }
  }

  const checkpoint = (await getBillingCheckpoint(callId)) as Record<string, unknown> | null;
  if (!checkpoint) {
    logWarning('billing_runtime_missing', {
      callId,
      source: 'missing',
      reason: terminalRaw ? 'terminal_unparseable_no_checkpoint' : 'no_session_no_checkpoint',
    });
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
    logWarning('billing_runtime_missing', {
      callId,
      source: 'missing',
      reason: 'checkpoint_unparseable',
    });
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
  logWarning('billing_runtime_reconstructed_from_checkpoint', {
    callId,
    source: 'checkpoint',
    lifecycleState: session.lifecycleState,
    billingSequence: session.billingSequence,
    balanceMicros,
    elapsedSeconds: session.elapsedSeconds,
  });
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
    if (runtime.terminalSnapshot) {
      await redis.del(activeCallByUserKey(firebaseUid)).catch(() => {});
      const staleSlotStillExists = Boolean(await redis.get(activeCallByUserKey(firebaseUid)));
      logInfo('billing_active_call_slot_terminal_tombstone_cleanup', {
        firebaseUid,
        staleCallId: slotCallId,
        activeCallKeyDeleted: true,
        activeCallKeyExistsAfterDelete: staleSlotStillExists,
      });
      recordBillingMetric('billing_active_slot_terminal_cleared', 1, {
        firebaseUid,
      });
    } else if (runtime.session) {
      logDebug('billing_active_runtime_lookup', {
        firebaseUid,
        callId: slotCallId,
        lookupSource: 'slot',
        runtimeSource: runtime.source,
      });
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
    logWarning('billing_active_call_slot_stale', {
      firebaseUid,
      staleCallId: slotCallId,
      runtimeSource: runtime.source,
    });
    await redis.del(activeCallByUserKey(firebaseUid)).catch(() => {});
    const staleSlotStillExists = Boolean(await redis.get(activeCallByUserKey(firebaseUid)));
    logInfo('billing_active_call_slot_stale_cleanup', {
      firebaseUid,
      staleCallId: slotCallId,
      activeCallKeyDeleted: true,
      activeCallKeyExistsAfterDelete: staleSlotStillExists,
    });
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
      const callId = parseCallIdFromSessionRedisKey(key);
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
      logInfo('billing_active_call_slot_backfilled_from_scan', {
        firebaseUid,
        callId,
      });
      logInfo('billing_active_runtime_lookup', {
        firebaseUid,
        callId,
        lookupSource: 'scan',
        runtimeSource: runtime.source,
        scannedKeys: scanned,
      });
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

  logDebug('billing_active_runtime_lookup', {
    firebaseUid,
    lookupSource: 'none',
    scannedKeys: scanned,
  });
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

