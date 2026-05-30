import { Server } from 'socket.io';
import axios from 'axios';
import mongoose from 'mongoose';
import { randomUUID } from 'crypto';
import { Call } from './call.model';
import { User } from '../user/user.model';
import { generateServerSideToken } from '../../config/stream-video';
import { getAvailability } from '../availability/availability.service';
import { transitionCreatorPresence } from '../availability/presence.service';
import {
  getRedis,
  CALL_RECONCILIATION_LOCK_KEY,
  RECONCILIATION_LOCK_TTL_MS,
  activeCallByUserKey,
  ACTIVE_CALL_BY_USER_PREFIX,
  ACTIVE_CALL_BY_USER_TTL,
  callSessionKey,
  availabilityKey,
  AVAILABILITY_KEY_PREFIX,
} from '../../config/redis';
import { featureFlags } from '../../config/feature-flags';
import { logInfo, logError } from '../../utils/logger';
import { recordCallMetric } from '../../utils/monitoring';
import { finalizeCallEnd } from './call-finalization.service';
import { getIO } from '../../config/socket';
import { resolveBillingRuntimeState } from '../billing/billing-runtime-resolver.service';
import { creatorPresenceMetaKey } from '../availability/presence.service';

let reconciliationTimer: NodeJS.Timeout | null = null;

const RECONCILIATION_INTERVAL_MS =
  parseInt(process.env.CALL_RECONCILIATION_INTERVAL_MS || '300000', 10) || // default 5 minutes
  300000;

const RECON_BATCH_SIZE = 100;
/** Max time per tick to avoid blocking event loop on huge backlogs */
const RECON_MAX_MS_PER_TICK = 45_000;
const RECON_PARALLELISM =
  Math.min(20, Math.max(1, parseInt(process.env.CALL_RECONCILIATION_PARALLELISM || '6', 10))) || 6;
const RECON_BATCH_PAUSE_MS =
  Math.min(1000, Math.max(0, parseInt(process.env.CALL_RECONCILIATION_BATCH_PAUSE_MS || '100', 10))) || 100;
const RECON_SETTLED_RESTORE_AGE_MS =
  Math.max(30_000, parseInt(process.env.CALL_RECONCILIATION_SETTLED_RESTORE_AGE_MS || '30000', 10) || 30_000);
const PRESENCE_STARTUP_REPAIR_ENABLED = process.env.PRESENCE_STARTUP_REPAIR_ENABLED !== 'false';
const PRESENCE_STARTUP_REPAIR_DRY_RUN = process.env.PRESENCE_STARTUP_REPAIR_DRY_RUN === 'true';
const PRESENCE_STARTUP_REPAIR_SCAN_LIMIT = Math.min(
  20_000,
  Math.max(1, parseInt(process.env.PRESENCE_STARTUP_REPAIR_SCAN_LIMIT || '2000', 10) || 2000)
);
const PRESENCE_STARTUP_REPAIR_TIMEOUT_MS = Math.min(
  120_000,
  Math.max(5_000, parseInt(process.env.PRESENCE_STARTUP_REPAIR_TIMEOUT_MS || '45000', 10) || 45_000)
);
const PRESENCE_STARTUP_REPAIR_SCAN_COUNT = Math.min(
  1000,
  Math.max(50, parseInt(process.env.PRESENCE_STARTUP_REPAIR_SCAN_COUNT || '200', 10) || 200)
);
const PRESENCE_CANONICAL_BACKFILL_SCAN_LIMIT = Math.min(
  5000,
  Math.max(50, parseInt(process.env.PRESENCE_CANONICAL_BACKFILL_SCAN_LIMIT || '500', 10) || 500)
);
const PRESENCE_CANONICAL_BACKFILL_SCAN_COUNT = Math.min(
  500,
  Math.max(50, parseInt(process.env.PRESENCE_CANONICAL_BACKFILL_SCAN_COUNT || '200', 10) || 200)
);
const PRESENCE_CANONICAL_BACKFILL_MAX_REPAIRS = Math.min(
  500,
  Math.max(1, parseInt(process.env.PRESENCE_CANONICAL_BACKFILL_MAX_REPAIRS || '80', 10) || 80)
);
const PRESENCE_CANONICAL_BACKFILL_TIMEOUT_MS = Math.min(
  120_000,
  Math.max(3_000, parseInt(process.env.PRESENCE_CANONICAL_BACKFILL_TIMEOUT_MS || '15000', 10) || 15_000)
);
const PRESENCE_STARTUP_REPAIR_STARTING_MAX_AGE_MS = Math.min(
  24 * 60 * 60 * 1000,
  Math.max(
    60_000,
    parseInt(process.env.PRESENCE_STARTUP_REPAIR_STARTING_MAX_AGE_MS || '180000', 10) || 180_000
  )
);
const RELEASE_LOCK_LUA = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;

/** Limit scanning of ancient unsettled rows (ms). Active ringing/accepted always included. */
const RECON_UNSETTLED_LOOKBACK_MS =
  parseInt(process.env.CALL_RECON_UNSETTLED_LOOKBACK_MS || String(7 * 24 * 60 * 60 * 1000), 10) ||
  7 * 24 * 60 * 60 * 1000;

function isTerminalLifecycleState(state: string | undefined): boolean {
  return state === 'SETTLED' || state === 'FAILED' || state === 'FAILED_RECOVERY_SETTLEMENT';
}

function parseUidFromActiveSlotKey(key: string): string | null {
  if (!key.startsWith(ACTIVE_CALL_BY_USER_PREFIX)) return null;
  const uid = key.slice(ACTIVE_CALL_BY_USER_PREFIX.length).trim();
  return uid.length > 0 ? uid : null;
}

function parseUidFromAvailabilityKey(key: string): string | null {
  if (!key.startsWith(AVAILABILITY_KEY_PREFIX)) return null;
  const uid = key.slice(AVAILABILITY_KEY_PREFIX.length).trim();
  return uid.length > 0 ? uid : null;
}

async function repairMissingCanonicalPresenceMeta(): Promise<void> {
  if (!featureFlags.creatorPresenceBackfillEnabled) {
    return;
  }
  const redis = getRedis();
  const startedAt = Date.now();
  const dryRun = featureFlags.creatorPresenceBackfillDryRun;
  let cursor = '0';
  let scanned = 0;
  let missingMeta = 0;
  let repaired = 0;
  let failed = 0;
  let parseFailures = 0;

  while (Date.now() - startedAt < PRESENCE_CANONICAL_BACKFILL_TIMEOUT_MS) {
    if (scanned >= PRESENCE_CANONICAL_BACKFILL_SCAN_LIMIT) break;
    if (!dryRun && repaired >= PRESENCE_CANONICAL_BACKFILL_MAX_REPAIRS) break;

    const [nextCursor, keys] = await redis.scan(
      cursor,
      'MATCH',
      `${AVAILABILITY_KEY_PREFIX}*`,
      'COUNT',
      String(PRESENCE_CANONICAL_BACKFILL_SCAN_COUNT)
    );
    cursor = nextCursor;
    if (!keys || keys.length === 0) {
      if (cursor === '0') break;
      continue;
    }

    for (const key of keys) {
      if (Date.now() - startedAt >= PRESENCE_CANONICAL_BACKFILL_TIMEOUT_MS) break;
      if (scanned >= PRESENCE_CANONICAL_BACKFILL_SCAN_LIMIT) break;
      if (!dryRun && repaired >= PRESENCE_CANONICAL_BACKFILL_MAX_REPAIRS) break;

      scanned += 1;
      const firebaseUid = parseUidFromAvailabilityKey(key);
      if (!firebaseUid) {
        parseFailures += 1;
        continue;
      }
      const [baseRaw, metaRaw] = await redis.mget(key, creatorPresenceMetaKey(firebaseUid));
      if (baseRaw == null || metaRaw != null) {
        continue;
      }
      missingMeta += 1;
      if (dryRun) {
        continue;
      }
      try {
        await transitionCreatorPresence(
          getIO(),
          firebaseUid,
          'RECONCILED',
          'presence.backfill.reconciliation'
        );
        repaired += 1;
      } catch (err) {
        failed += 1;
        logError('presence_backfill_repair_failed', err, {
          firebaseUid,
          source: 'call-reconciliation',
        });
      }
    }
    if (cursor === '0') break;
  }

  recordCallMetric('presence.backfill_scan', scanned, {
    dryRun: dryRun ? '1' : '0',
  });
  recordCallMetric('presence.backfill_would_repair_count', missingMeta, {
    dryRun: dryRun ? '1' : '0',
  });
  recordCallMetric('presence.backfill_repaired_count', repaired, {
    dryRun: dryRun ? '1' : '0',
  });
  recordCallMetric('presence.backfill_failed_count', failed, {
    dryRun: dryRun ? '1' : '0',
  });
  if (parseFailures > 0) {
    recordCallMetric('presence.backfill_key_parse_failures', parseFailures, {
      dryRun: dryRun ? '1' : '0',
    });
  }
  logInfo('Presence canonical backfill pass completed', {
    dryRun,
    scanned,
    missingMeta,
    repaired,
    failed,
    parseFailures,
    durationMs: Date.now() - startedAt,
  });
}

function runtimeSessionAgeMs(
  session: { startTime?: number; lastProcessedAt?: number },
  callId: string
): number {
  const baseTs = Number(session?.startTime) || Number(session?.lastProcessedAt) || 0;
  if (Number.isFinite(baseTs) && baseTs > 0) {
    return Math.max(0, Date.now() - baseTs);
  }
  const match = String(callId || '').match(/_(\d{10})$/);
  if (!match) return 0;
  const epochSeconds = Number(match[1]);
  if (!Number.isFinite(epochSeconds) || epochSeconds <= 0) return 0;
  return Math.max(0, Date.now() - epochSeconds * 1000);
}

function isLikelyBootstrappingStartingSession(
  session: { billingSequence?: number; elapsedSeconds?: number }
): boolean {
  const seq = Number(session?.billingSequence || 0);
  const elapsed = Number(session?.elapsedSeconds || 0);
  return seq <= 0 && elapsed <= 0;
}

function shouldTreatStartingAsStale(
  session: {
    lifecycleState?: string;
    startTime?: number;
    lastProcessedAt?: number;
    billingSequence?: number;
    elapsedSeconds?: number;
  },
  callId: string
): { stale: boolean; ageMs: number } {
  if (session?.lifecycleState !== 'STARTING') {
    return { stale: false, ageMs: 0 };
  }
  const ageMs = runtimeSessionAgeMs(session, callId);
  if (ageMs <= PRESENCE_STARTUP_REPAIR_STARTING_MAX_AGE_MS) {
    return { stale: false, ageMs };
  }
  // Only force-clear when we still look pre-tick; avoid touching active progressing sessions.
  if (!isLikelyBootstrappingStartingSession(session)) {
    return { stale: false, ageMs };
  }
  return { stale: true, ageMs };
}

export async function repairStaleActiveCallSlotsOnStartup(): Promise<void> {
  if (!PRESENCE_STARTUP_REPAIR_ENABLED) {
    logInfo('Startup active-call slot repair disabled', {
      enabled: false,
      dryRun: PRESENCE_STARTUP_REPAIR_DRY_RUN,
    });
    return;
  }

  const redis = getRedis();
  const startedAt = Date.now();
  let cursor = '0';
  let scanned = 0;
  let healthy = 0;
  let staleDetected = 0;
  let cleared = 0;
  let dryRunMarked = 0;
  let recomputed = 0;
  let recomputeFailed = 0;
  let skippedInvalidKey = 0;
  let scanComplete = false;

  logInfo('Startup active-call slot repair started', {
    enabled: PRESENCE_STARTUP_REPAIR_ENABLED,
    dryRun: PRESENCE_STARTUP_REPAIR_DRY_RUN,
    scanLimit: PRESENCE_STARTUP_REPAIR_SCAN_LIMIT,
    timeoutMs: PRESENCE_STARTUP_REPAIR_TIMEOUT_MS,
    scanCount: PRESENCE_STARTUP_REPAIR_SCAN_COUNT,
    startingMaxAgeMs: PRESENCE_STARTUP_REPAIR_STARTING_MAX_AGE_MS,
  });

  while (Date.now() - startedAt < PRESENCE_STARTUP_REPAIR_TIMEOUT_MS) {
    if (scanned >= PRESENCE_STARTUP_REPAIR_SCAN_LIMIT) break;

    const [nextCursor, keys] = await redis.scan(
      cursor,
      'MATCH',
      `${ACTIVE_CALL_BY_USER_PREFIX}*`,
      'COUNT',
      String(PRESENCE_STARTUP_REPAIR_SCAN_COUNT)
    );
    cursor = nextCursor;

    for (const key of keys || []) {
      if (Date.now() - startedAt >= PRESENCE_STARTUP_REPAIR_TIMEOUT_MS) break;
      if (scanned >= PRESENCE_STARTUP_REPAIR_SCAN_LIMIT) break;
      scanned += 1;

      const firebaseUid = parseUidFromActiveSlotKey(key);
      if (!firebaseUid) {
        skippedInvalidKey += 1;
        continue;
      }

      const slotCallId = await redis.get(key);
      if (!slotCallId) {
        healthy += 1;
        continue;
      }

      let stale = false;
      let runtimeSource: string | undefined;
      let lifecycleState: string | undefined;
      let runtimeAgeMs: number | undefined;
      try {
        const runtime = await resolveBillingRuntimeState(slotCallId);
        runtimeSource = runtime.source;
        lifecycleState = runtime.session?.lifecycleState;
        const staleStartingDecision = runtime.session
          ? shouldTreatStartingAsStale(runtime.session, slotCallId)
          : { stale: false, ageMs: 0 };
        runtimeAgeMs = staleStartingDecision.ageMs;
        const staleStarting = staleStartingDecision.stale;
        stale =
          runtime.source === 'missing' ||
          Boolean(runtime.terminalSnapshot) ||
          !runtime.session ||
          isTerminalLifecycleState(runtime.session.lifecycleState) ||
          staleStarting;
      } catch (err) {
        logError('Startup slot repair runtime resolution failed; treating as stale', err, {
          firebaseUid,
          slotCallId,
        });
        stale = true;
      }

      if (!stale) {
        healthy += 1;
        continue;
      }

      staleDetected += 1;
      recordCallMetric('presence_startup_slot_stale_detected', 1, {
        runtimeSource: runtimeSource || 'unknown',
        lifecycleState: lifecycleState || 'none',
      });

      if (PRESENCE_STARTUP_REPAIR_DRY_RUN) {
        dryRunMarked += 1;
        logInfo('Startup slot repair dry-run detected stale slot', {
          firebaseUid,
          slotCallId,
          runtimeSource: runtimeSource || 'unknown',
          lifecycleState: lifecycleState || 'none',
          runtimeAgeMs: runtimeAgeMs || 0,
        });
        continue;
      }

      await redis.del(key).catch(() => {});
      const keyStillExists = Boolean(await redis.get(key));
      if (keyStillExists) {
        logInfo('Startup slot repair could not delete stale slot key', {
          firebaseUid,
          slotCallId,
        });
        continue;
      }

      cleared += 1;
      recordCallMetric('presence_startup_slot_cleared', 1, {
        runtimeSource: runtimeSource || 'unknown',
        lifecycleState: lifecycleState || 'none',
      });
      logInfo('Startup slot repair cleared stale slot key', {
        firebaseUid,
        slotCallId,
        runtimeSource: runtimeSource || 'unknown',
        lifecycleState: lifecycleState || 'none',
        runtimeAgeMs: runtimeAgeMs || 0,
      });

      try {
        await transitionCreatorPresence(
          getIO(),
          firebaseUid,
          'RECONCILED',
          'startup.presence_slot_repair'
        );
        recomputed += 1;
      } catch (err) {
        recomputeFailed += 1;
        recordCallMetric('presence_startup_recompute_failed', 1, {});
        logError('Startup slot repair failed to recompute presence', err, {
          firebaseUid,
          slotCallId,
        });
      }
    }

    if (cursor === '0') {
      scanComplete = true;
      break;
    }
  }

  recordCallMetric('presence_startup_slot_scan', scanned, {
    dryRun: PRESENCE_STARTUP_REPAIR_DRY_RUN ? '1' : '0',
  });
  logInfo('Startup active-call slot repair completed', {
    scanComplete,
    scanned,
    healthy,
    staleDetected,
    cleared,
    dryRunMarked,
    recomputed,
    recomputeFailed,
    skippedInvalidKey,
    durationMs: Date.now() - startedAt,
    timedOut: Date.now() - startedAt >= PRESENCE_STARTUP_REPAIR_TIMEOUT_MS,
  });
}

function activeCallFilterAfter(
  lastId: mongoose.Types.ObjectId | null
): mongoose.FilterQuery<typeof Call> {
  const recentCutoff = new Date(Date.now() - RECON_UNSETTLED_LOOKBACK_MS);
  const unsettledRecent = {
    isSettled: { $ne: true },
    updatedAt: { $gte: recentCutoff },
  };
  const base: mongoose.FilterQuery<typeof Call> = {
    $or: [{ status: { $in: ['ringing', 'accepted'] } }, unsettledRecent],
  };
  if (!lastId) {
    return base;
  }
  return { $and: [base, { _id: { $gt: lastId } }] };
}

async function fetchActiveCallBatch(
  lastId: mongoose.Types.ObjectId | null
): Promise<Array<InstanceType<typeof Call>>> {
  return Call.find(activeCallFilterAfter(lastId))
    .sort({ _id: 1 })
    .limit(RECON_BATCH_SIZE)
    .exec();
}

function settledCallFilterAfter(
  lastId: mongoose.Types.ObjectId | null
): mongoose.FilterQuery<typeof Call> {
  const settledBefore = new Date(Date.now() - RECON_SETTLED_RESTORE_AGE_MS);
  const lookbackCutoff = new Date(Date.now() - RECON_UNSETTLED_LOOKBACK_MS);
  const base: mongoose.FilterQuery<typeof Call> = {
    isSettled: true,
    status: 'ended',
    updatedAt: { $lte: settledBefore, $gte: lookbackCutoff },
  };
  if (!lastId) return base;
  return { $and: [base, { _id: { $gt: lastId } }] };
}

async function fetchSettledCallBatch(
  lastId: mongoose.Types.ObjectId | null
): Promise<Array<InstanceType<typeof Call>>> {
  return Call.find(settledCallFilterAfter(lastId))
    .sort({ _id: 1 })
    .limit(RECON_BATCH_SIZE)
    .exec();
}

async function cleanupSettledCreatorBusyDrift(): Promise<void> {
  try {
    const redis = getRedis();
    const passStarted = Date.now();
    let lastId: mongoose.Types.ObjectId | null = null;
    let scanned = 0;
    let fixed = 0;

    while (Date.now() - passStarted < RECON_MAX_MS_PER_TICK) {
      const settledCalls = await fetchSettledCallBatch(lastId);
      if (!settledCalls.length) {
        break;
      }

      for (const call of settledCalls) {
        try {
          const creatorUser = await User.findById(call.creatorUserId);
          if (!creatorUser?.firebaseUid) {
            continue;
          }
          const creatorFirebaseUid = creatorUser.firebaseUid;
          const slotKey = activeCallByUserKey(creatorFirebaseUid);
          const slotCallId = await redis.get(slotKey);
          const sessionForSlot = slotCallId ? await redis.get(callSessionKey(slotCallId)) : null;

          if (slotCallId === call.callId && !sessionForSlot) {
            await redis.del(slotKey).catch(() => {});
            const keyStillExists = Boolean(await redis.get(slotKey));
            logInfo('Reconciliation cleared stale active call slot for settled call', {
              callId: call.callId,
              creatorFirebaseUid,
              activeCallKeyDeleted: true,
              activeCallKeyExistsAfterDelete: keyStillExists,
            });
          }

          const activeCallAfterCleanup = await redis.get(slotKey);
          if (activeCallAfterCleanup) {
            continue;
          }

          const hasOtherLiveCall = await Call.exists({
            creatorUserId: call.creatorUserId,
            _id: { $ne: call._id },
            $or: [{ status: { $in: ['ringing', 'accepted'] } }, { isSettled: { $ne: true } }],
          });
          if (hasOtherLiveCall) {
            continue;
          }

          const baseAvailability = await redis.get(availabilityKey(creatorFirebaseUid));
          const currentStatus = await getAvailability(creatorFirebaseUid);
          if (baseAvailability !== 'online') {
            // Ghost on_call: toggle/base is offline but effective status still on_call (stale meta).
            if (currentStatus === 'on_call') {
              await transitionCreatorPresence(
                getIO(),
                creatorFirebaseUid,
                'DISCONNECTED',
                'call-reconciliation.clear_ghost_on_call_offline_base'
              );
              fixed += 1;
              logInfo('Reconciliation cleared ghost on_call (creator base offline)', {
                callId: call.callId,
                creatorFirebaseUid,
                baseAvailability: baseAvailability || 'offline',
              });
            } else {
              recordCallMetric('call_reconciliation.settled_restore_skipped', 1, {
                reason: 'base_offline',
              });
              logInfo('Reconciliation skipped settled restore (creator base offline)', {
                callId: call.callId,
                creatorFirebaseUid,
                baseAvailability: baseAvailability || 'offline',
              });
            }
            continue;
          }
          if (currentStatus !== 'on_call') {
            recordCallMetric('call_reconciliation.settled_restore_skipped', 1, {
              reason: 'status_not_on_call',
            });
            continue;
          }

          const settlementAgeMs = Math.max(
            0,
            Date.now() - (call.updatedAt ? new Date(call.updatedAt).getTime() : Date.now())
          );
          if (settlementAgeMs < RECON_SETTLED_RESTORE_AGE_MS) {
            continue;
          }

          await transitionCreatorPresence(
            getIO(),
            creatorFirebaseUid,
            'RECONCILED',
            'call-reconciliation.cleanupSettledCreatorBusyDrift'
          );
          fixed += 1;
          logInfo('Reconciliation restored creator status after settled call', {
            callId: call.callId,
            creatorFirebaseUid,
            settlementAgeMs,
            thresholdMs: RECON_SETTLED_RESTORE_AGE_MS,
          });
        } catch (err) {
          logError('Error reconciling settled creator busy drift', err, {
            callId: call.callId,
          });
        }
      }

      scanned += settledCalls.length;
      lastId = settledCalls[settledCalls.length - 1]._id as mongoose.Types.ObjectId;
      if (RECON_BATCH_PAUSE_MS > 0) {
        await new Promise((resolve) => setTimeout(resolve, RECON_BATCH_PAUSE_MS));
      }
      if (settledCalls.length < RECON_BATCH_SIZE) {
        break;
      }
    }

    recordCallMetric('call_reconciliation.settled_busy_scan', scanned, {});
    recordCallMetric('call_reconciliation.settled_busy_fixed', fixed, {});
  } catch (err) {
    logError('Error in cleanupSettledCreatorBusyDrift', err);
  }
}

/**
 * Clear Redis active-call slots that have no live billing session (forces effective offline/on_call fix).
 */
async function cleanupOrphanActiveCallSlots(): Promise<void> {
  const redis = getRedis();
  const passStarted = Date.now();
  let cursor = '0';
  let scanned = 0;
  let cleared = 0;

  try {
    do {
      const [next, keys] = await redis.scan(
        cursor,
        'MATCH',
        `${ACTIVE_CALL_BY_USER_PREFIX}*`,
        'COUNT',
        '100'
      );
      cursor = next;
      for (const key of keys) {
        if (Date.now() - passStarted > RECON_MAX_MS_PER_TICK) {
          return;
        }
        scanned += 1;
        const firebaseUid = key.slice(ACTIVE_CALL_BY_USER_PREFIX.length).trim();
        if (!firebaseUid) continue;
        const slotCallId = await redis.get(key);
        if (!slotCallId) continue;
        const sessionForSlot = await redis.get(callSessionKey(slotCallId));
        if (sessionForSlot) continue;

        await redis.del(key).catch(() => {});
        const currentStatus = await getAvailability(firebaseUid);
        if (currentStatus === 'on_call') {
          await transitionCreatorPresence(
            getIO(),
            firebaseUid,
            'RECONCILED',
            'call-reconciliation.cleanupOrphanActiveCallSlots'
          );
        }
        cleared += 1;
        logInfo('Reconciliation cleared orphan active call slot', {
          creatorFirebaseUid: firebaseUid,
          slotCallId,
          previousStatus: currentStatus,
        });
      }
    } while (cursor !== '0');
    recordCallMetric('call_reconciliation.orphan_slot_scan', scanned, {});
    recordCallMetric('call_reconciliation.orphan_slot_cleared', cleared, {});
  } catch (err) {
    logError('Error in cleanupOrphanActiveCallSlots', err);
  }
}

/**
 * Simple call state reconciliation job.
 *
 * Goal:
 * - Detect obvious drifts between our Call records and Stream's truth.
 * - Auto‑close obviously stale calls to avoid infinite "accepted" state.
 *
 * Strategy:
 * - Look for calls that appear active in our DB:
 *   status in ['ringing', 'accepted'] OR (!isSettled)
 * - For each, query Stream's call by callId.
 * - If Stream reports the call/session ended, mark our Call as ended/settled.
 *
 * NOTE: This is intentionally conservative and only auto‑fixes the "clearly ended"
 *       case. It logs discrepancies for further investigation.
 */
export function startCallReconciliationJob(_io: Server): void {
  if (reconciliationTimer) {
    logInfo('Call reconciliation job already running', {});
    return;
  }

  logInfo('Starting call reconciliation job', {
    intervalMs: RECONCILIATION_INTERVAL_MS,
  });

  // Fire once on startup
  reconcileActiveCallsWithLock().catch((err) => {
    logError('Initial call reconciliation failed', err);
  });

  reconciliationTimer = setInterval(() => {
    reconcileActiveCallsWithLock().catch((err) => {
      logError('Scheduled call reconciliation failed', err);
    });
  }, RECONCILIATION_INTERVAL_MS);
}

export function stopCallReconciliationJob(): void {
  if (reconciliationTimer) {
    clearInterval(reconciliationTimer);
    reconciliationTimer = null;
    logInfo('Stopped call reconciliation job', {});
  }
}

/**
 * 🔥 FIX: Ensure creators with active calls are marked on_call
 * This is a safety net to catch any cases where creators weren't marked on_call
 */
async function ensureCreatorsWithActiveCallsAreBusy(): Promise<void> {
  try {
    const passStarted = Date.now();
    let lastId: mongoose.Types.ObjectId | null = null;
    let scanned = 0;

    while (Date.now() - passStarted < RECON_MAX_MS_PER_TICK) {
      const activeCalls = await fetchActiveCallBatch(lastId);
      if (!activeCalls.length) {
        break;
      }

      for (const call of activeCalls) {
        try {
          const creatorUser = await User.findById(call.creatorUserId);
          if (creatorUser?.firebaseUid) {
            const currentStatus = await getAvailability(creatorUser.firebaseUid);

            if (currentStatus !== 'on_call') {
              if (featureFlags.creatorPresenceUserModelEnabled) {
                const redis = getRedis();
                await redis.set(
                  activeCallByUserKey(creatorUser.firebaseUid),
                  call.callId,
                  'EX',
                  ACTIVE_CALL_BY_USER_TTL
                );
              }
              await transitionCreatorPresence(
                getIO(),
                creatorUser.firebaseUid,
                'CALL_STARTED',
                'call-reconciliation.ensureCreatorsWithActiveCallsAreBusy'
              );
              logInfo('Reconciliation: Fixed creator on_call status', {
                callId: call.callId,
                creatorFirebaseUid: creatorUser.firebaseUid,
                previousStatus: currentStatus,
              });
            }
          }
        } catch (err) {
          logError('Error ensuring creator busy status in reconciliation', err, {
            callId: call.callId,
          });
        }
      }

      scanned += activeCalls.length;
      lastId = activeCalls[activeCalls.length - 1]._id as mongoose.Types.ObjectId;
      if (RECON_BATCH_PAUSE_MS > 0) {
        await new Promise((resolve) => setTimeout(resolve, RECON_BATCH_PAUSE_MS));
      }
      if (activeCalls.length < RECON_BATCH_SIZE) {
        break;
      }
    }

    recordCallMetric('call_reconciliation.busy_scan', scanned, {});
  } catch (err) {
    logError('Error in ensureCreatorsWithActiveCallsAreBusy', err);
  }
}

async function releaseLock(lockKey: string, token: string): Promise<void> {
  const redis = getRedis();
  try {
    await redis.eval(RELEASE_LOCK_LUA, 1, lockKey, token);
  } catch {
    // ignore release failure
  }
}

async function reconcileActiveCallsWithLock(): Promise<void> {
  const redis = getRedis();
  const token = randomUUID();
  const lockResult = await redis.set(
    CALL_RECONCILIATION_LOCK_KEY,
    token,
    'PX',
    RECONCILIATION_LOCK_TTL_MS,
    'NX'
  );
  if (lockResult !== 'OK') {
    recordCallMetric('call_reconciliation.skipped_lock_busy', 1, {});
    return;
  }

  const heartbeat = setInterval(() => {
    redis
      .set(CALL_RECONCILIATION_LOCK_KEY, token, 'PX', RECONCILIATION_LOCK_TTL_MS, 'XX')
      .catch(() => {});
  }, Math.max(1000, Math.floor(RECONCILIATION_LOCK_TTL_MS / 3)));

  try {
    await reconcileActiveCalls();
  } finally {
    clearInterval(heartbeat);
    await releaseLock(CALL_RECONCILIATION_LOCK_KEY, token);
  }
}

async function reconcileActiveCalls(): Promise<void> {
  try {
    const runStartedAt = Date.now();
    await ensureCreatorsWithActiveCallsAreBusy();
    await cleanupOrphanActiveCallSlots();
    await cleanupSettledCreatorBusyDrift();
    await repairMissingCanonicalPresenceMeta();

    const apiKey = process.env.STREAM_API_KEY;
    const baseUrl = 'https://video.stream-io-api.com';

    if (!apiKey) {
      logError(
        'Call reconciliation: STREAM_API_KEY not set, skipping Stream checks',
        new Error('Missing STREAM_API_KEY')
      );
      return;
    }

    const serverToken = generateServerSideToken();
    const passStarted = Date.now();
    let lastId: mongoose.Types.ObjectId | null = null;
    let totalChecked = 0;

    while (Date.now() - passStarted < RECON_MAX_MS_PER_TICK) {
      const activeCalls = await fetchActiveCallBatch(lastId);

      if (!activeCalls.length) {
        if (totalChecked === 0) {
          logInfo('Call reconciliation: no active calls to check', {});
        }
        break;
      }

      if (totalChecked === 0) {
        logInfo('Call reconciliation: checking active calls (paginated)', {
          firstBatchSize: activeCalls.length,
        });
      }

      for (let i = 0; i < activeCalls.length; i += RECON_PARALLELISM) {
        const batch = activeCalls.slice(i, i + RECON_PARALLELISM);
        await Promise.allSettled(
          batch.map(async (call) => {
            const callId = call.callId;
            try {
        // Query Stream Video for call state
        const url = `${baseUrl}/video/calls/default/${encodeURIComponent(
          callId
        )}?api_key=${apiKey}`;

        const resp = await axios.get(url, {
          headers: {
            Authorization: `Bearer ${serverToken}`,
          },
          timeout: 7000,
        });

        const streamCall = resp.data?.call;
        const ended =
          streamCall?.ended_at ||
          streamCall?.session?.ended_at ||
          streamCall?.state === 'ended';

        if (!ended) {
          // Stream still thinks call is active; nothing to do
          return;
        }

        // If Stream says ended but our Call is still not ended/settled, run the
        // same centralized end finalizer used by webhooks/socket handlers.
        if (call.status !== 'ended' || !call.isSettled) {
          logInfo('Reconciling ended call from Stream', {
            callId,
            currentStatus: call.status,
            isSettled: call.isSettled,
          });
          await finalizeCallEnd(getIO(), callId, 'reconciliation_stream_ended');
        }
      } catch (err: any) {
        // 404 from Stream: call unknown → treat as ended and close locally
        const status = err?.response?.status;
        if (status === 404) {
          logInfo('Reconciling locally for call missing in Stream', { callId });
          if (call.status !== 'ended' || !call.isSettled) {
            await finalizeCallEnd(getIO(), callId, 'reconciliation_stream_404');
          }
        } else {
          logError('Error reconciling call with Stream', err, { callId });
        }
      }})
        );
        if (RECON_BATCH_PAUSE_MS > 0 && i + RECON_PARALLELISM < activeCalls.length) {
          await new Promise((resolve) => setTimeout(resolve, RECON_BATCH_PAUSE_MS));
        }
      }

      totalChecked += activeCalls.length;
      lastId = activeCalls[activeCalls.length - 1]._id as mongoose.Types.ObjectId;
      if (activeCalls.length < RECON_BATCH_SIZE) {
        break;
      }
    }

    recordCallMetric('call_reconciliation.stream_checked', totalChecked, {});
    recordCallMetric('call_reconciliation.run_ms', Date.now() - runStartedAt, {
      checked: String(totalChecked),
    });
  } catch (err) {
    logError('Call reconciliation job failed', err);
  }
}

