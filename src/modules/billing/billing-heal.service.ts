import { Server } from 'socket.io';
import { getRedis, callSessionKey, callSessionTerminalKey } from '../../config/redis';
import { getIO } from '../../config/socket';
import { runsBillingWorkers } from '../../config/service-role';
import { billingService, CallSession, normalizeV4SessionFields } from './billing.service';
import { recoverBillingScheduleForCall } from './billing-recovery';
import { resolveBillingRuntimeState } from './billing-runtime-resolver.service';
import { needsBillingCycleReschedule } from './billing.queue';
import { getBillingChainHealStallMs } from './billing.constants';
import { logBillingHealth, logBillingHealthWarn } from './billing-health-log';
import {
  hasValidSessionPricing,
  repairSessionPricingIfNeeded,
} from './billing-session-pricing-repair.service';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadSessionForHeal(
  callId: string,
  source: string
): Promise<{ session: CallSession | null; hadSession: boolean }> {
  const redis = getRedis();
  let sessionRaw = await redis.get(callSessionKey(callId));
  if (!sessionRaw) {
    const hadTombstone = (await redis.exists(callSessionTerminalKey(callId))) === 1;
    if (hadTombstone) {
      await redis.del(callSessionTerminalKey(callId)).catch(() => 0);
      logBillingHealth('TOMBSTONE_CLEARED', { callId, source });
    }
    const runtime = await resolveBillingRuntimeState(callId);
    sessionRaw = runtime.session ? JSON.stringify(runtime.session) : null;
  }

  if (!sessionRaw) {
    return { session: null, hadSession: false };
  }

  let session = JSON.parse(sessionRaw) as CallSession;
  normalizeV4SessionFields(session);
  return { session, hadSession: true };
}

/**
 * Restart tick chain + run immediate tick(s) for a call that should still be billing.
 */
export async function healActiveCallBilling(
  io: Server,
  callId: string,
  source: string
): Promise<{ healed: boolean; tickResult?: string; hadSession: boolean }> {
  logBillingHealth('RECOVERY_HEAL_START', { callId, source });

  const loaded = await loadSessionForHeal(callId, source);
  if (!loaded.session) {
    logBillingHealthWarn('RECOVERY_HEAL_DONE', {
      callId,
      source,
      healed: false,
      reason: 'no_session',
    });
    return { healed: false, hadSession: false };
  }

  let session = loaded.session;
  const repairResult = await repairSessionPricingIfNeeded(io, callId, session, source);
  const hadValidPricing = hasValidSessionPricing(repairResult, session);

  if (!hadValidPricing) {
    logBillingHealthWarn('RECOVERY_HEAL_DONE', {
      callId,
      source,
      healed: false,
      reason: 'pricing_unresolved',
      repairReason: repairResult.reason,
    });
    return { healed: false, tickResult: 'pricing_unresolved', hadSession: true };
  }

  const refreshedRaw = await getRedis().get(callSessionKey(callId));
  if (refreshedRaw) {
    try {
      session = JSON.parse(refreshedRaw) as CallSession;
      normalizeV4SessionFields(session);
    } catch {
      /* use in-memory session */
    }
  }

  await recoverBillingScheduleForCall(callId, 'reconciliation');
  logBillingHealth('CHAIN_RESCHEDULED', { callId, source });

  let tickResult = await billingService.processBillingTick(io, callId);
  for (let attempt = 0; attempt < 4 && tickResult === 'tick_deferred'; attempt += 1) {
    await sleep(120);
    tickResult = await billingService.processBillingTick(io, callId);
  }

  const healed =
    tickResult === 'tick_ok' ||
    (tickResult === 'stop_needs_settlement' && hadValidPricing);
  logBillingHealth('RECOVERY_HEAL_DONE', {
    callId,
    source,
    healed,
    tickResult: tickResult ?? 'unknown',
    repairReason: repairResult.reason,
  });
  return { healed, tickResult, hadSession: true };
}

/**
 * Role-aware heal: api-ws schedule-only; billing-worker ticks only when stalled or reschedule needed.
 */
export async function healActiveCallBillingLight(
  io: Server,
  callId: string,
  source: string,
  sessionHint?: CallSession | null
): Promise<{ healed: boolean; tickResult?: string; hadSession: boolean; scheduleOnly: boolean }> {
  logBillingHealth('RECOVERY_HEAL_START', { callId, source, mode: 'light' });

  let session = sessionHint ?? null;
  if (!session) {
    const loaded = await loadSessionForHeal(callId, source);
    if (!loaded.session) {
      logBillingHealthWarn('RECOVERY_HEAL_DONE', {
        callId,
        source,
        healed: false,
        reason: 'no_session',
        mode: 'light',
      });
      return { healed: false, hadSession: false, scheduleOnly: true };
    }
    session = loaded.session;
  }

  const repairResult = await repairSessionPricingIfNeeded(io, callId, session, source);
  const hadValidPricing = hasValidSessionPricing(repairResult, session);
  if (!hadValidPricing) {
    logBillingHealthWarn('RECOVERY_HEAL_DONE', {
      callId,
      source,
      healed: false,
      reason: 'pricing_unresolved',
      repairReason: repairResult.reason,
      mode: 'light',
    });
    return { healed: false, tickResult: 'pricing_unresolved', hadSession: true, scheduleOnly: true };
  }

  const refreshedRaw = await getRedis().get(callSessionKey(callId));
  if (refreshedRaw) {
    try {
      session = JSON.parse(refreshedRaw) as CallSession;
      normalizeV4SessionFields(session);
    } catch {
      /* use in-memory session */
    }
  }

  const stalled = isBillingSequenceStalledOnSession(session);
  const needsReschedule = await needsBillingCycleReschedule(callId);
  const scheduled = await recoverBillingScheduleForCall(callId, 'reconciliation');
  if (scheduled) {
    logBillingHealth('CHAIN_RESCHEDULED', { callId, source, mode: 'light' });
  }

  if (!runsBillingWorkers()) {
    logBillingHealth('RECOVERY_HEAL_DONE', {
      callId,
      source,
      healed: scheduled || stalled || needsReschedule,
      tickResult: 'schedule_only_api_ws',
      mode: 'light',
    });
    return {
      healed: scheduled || stalled || needsReschedule,
      tickResult: 'schedule_only_api_ws',
      hadSession: true,
      scheduleOnly: true,
    };
  }

  if (!stalled && !needsReschedule) {
    logBillingHealth('RECOVERY_HEAL_DONE', {
      callId,
      source,
      healed: true,
      tickResult: 'schedule_only_healthy',
      mode: 'light',
    });
    return { healed: true, tickResult: 'schedule_only_healthy', hadSession: true, scheduleOnly: true };
  }

  let tickResult = await billingService.processBillingTick(io, callId);
  for (let attempt = 0; attempt < 4 && tickResult === 'tick_deferred'; attempt += 1) {
    await sleep(120);
    tickResult = await billingService.processBillingTick(io, callId);
  }

  const healed =
    tickResult === 'tick_ok' ||
    (tickResult === 'stop_needs_settlement' && hadValidPricing);
  logBillingHealth('RECOVERY_HEAL_DONE', {
    callId,
    source,
    healed,
    tickResult: tickResult ?? 'unknown',
    repairReason: repairResult.reason,
    mode: 'light',
  });
  return { healed, tickResult, hadSession: true, scheduleOnly: false };
}

export async function healActiveCallBillingWithDefaultIo(
  callId: string,
  source: string
): Promise<{ healed: boolean; tickResult?: string; hadSession: boolean }> {
  return healActiveCallBilling(getIO(), callId, source);
}

export async function healActiveCallBillingLightWithDefaultIo(
  callId: string,
  source: string,
  sessionHint?: CallSession | null
): Promise<{ healed: boolean; tickResult?: string; hadSession: boolean; scheduleOnly: boolean }> {
  return healActiveCallBillingLight(getIO(), callId, source, sessionHint);
}

export function isBillingSequenceStalledOnSession(session: {
  lifecycleState?: string;
  lastSequenceAdvanceAt?: number;
  lastHealthyTickAt?: number;
  startTime?: number;
}): boolean {
  const lifecycle = String(session.lifecycleState || 'ACTIVE');
  if (lifecycle !== 'ACTIVE' && lifecycle !== 'RECOVERING' && lifecycle !== 'STARTING') {
    return false;
  }
  const now = Date.now();
  const lastAdvance = Math.max(
    Number(session.lastSequenceAdvanceAt) || 0,
    Number(session.lastHealthyTickAt) || 0
  );
  const stallMs =
    lastAdvance > 0
      ? Math.max(0, now - lastAdvance)
      : Math.max(0, now - (Number(session.startTime) || now));
  return stallMs > getBillingChainHealStallMs();
}
