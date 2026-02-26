import { featureFlags } from '../../config/feature-flags';
import {
  billingMetricKey,
  billingShadowReportKey,
  billingShadowSessionKey,
  billingShadowSettleAuditKey,
  billingShadowSettleLockKey,
  billingShadowTickLeaseKey,
  getRedis,
  isRedisConfigured,
} from '../../config/redis';
import { logger } from '../../utils/logger';

const SHADOW_SESSION_TTL_SECONDS = 7200;
const SHADOW_TICK_LEASE_SECONDS = 2;
const SHADOW_SETTLE_LOCK_TTL_SECONDS = 7 * 24 * 60 * 60;
const SHADOW_REPORT_TTL_SECONDS = 7 * 24 * 60 * 60;
const SHADOW_CREATOR_EARNINGS_PER_SECOND = 0.3;

export interface BillingShadowStartInput {
  callId: string;
  userFirebaseUid: string;
  creatorFirebaseUid: string;
  userMongoId: string;
  creatorMongoId: string;
  pricePerMinute: number;
  pricePerSecond: number;
  startingUserCoins: number;
}

export interface BillingLegacySettlementSnapshot {
  callId: string;
  elapsedSeconds: number;
  finalCoins: number;
  finalEarnings: number;
  totalDeducted: number;
}

interface BillingShadowSession extends BillingShadowStartInput {
  startTime: number;
  elapsedSeconds: number;
  userCoinsExact: number;
  creatorEarningsExact: number;
}

export interface BillingShadowComparisonReport {
  callId: string;
  timestamp: string;
  elapsedSecondsLegacy: number;
  elapsedSecondsShadow: number;
  finalCoinsLegacy: number;
  finalCoinsShadow: number;
  totalDeductedLegacy: number;
  totalDeductedShadow: number;
  finalEarningsLegacy: number;
  finalEarningsShadow: number;
  durationMs: number;
  mismatch: boolean;
  mismatchFields: string[];
}

const toFixedNumber = (value: number, digits = 4): number =>
  Number(value.toFixed(digits));

const parseShadowSession = (raw: string | null): BillingShadowSession | null => {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as BillingShadowSession;
  } catch {
    return null;
  }
};

const metricDeltaFrom = (raw: string | null): number => {
  if (!raw) return 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
};

export const compareSettlementSnapshots = (
  legacy: BillingLegacySettlementSnapshot,
  shadow: BillingLegacySettlementSnapshot,
  durationMs: number,
): BillingShadowComparisonReport => {
  const mismatchFields: string[] = [];
  if (legacy.elapsedSeconds !== shadow.elapsedSeconds) mismatchFields.push('elapsedSeconds');
  if (toFixedNumber(legacy.finalCoins, 2) !== toFixedNumber(shadow.finalCoins, 2)) mismatchFields.push('finalCoins');
  if (toFixedNumber(legacy.totalDeducted, 2) !== toFixedNumber(shadow.totalDeducted, 2)) mismatchFields.push('totalDeducted');
  if (toFixedNumber(legacy.finalEarnings, 2) !== toFixedNumber(shadow.finalEarnings, 2)) mismatchFields.push('finalEarnings');

  return {
    callId: legacy.callId,
    timestamp: new Date().toISOString(),
    elapsedSecondsLegacy: legacy.elapsedSeconds,
    elapsedSecondsShadow: shadow.elapsedSeconds,
    finalCoinsLegacy: toFixedNumber(legacy.finalCoins, 4),
    finalCoinsShadow: toFixedNumber(shadow.finalCoins, 4),
    totalDeductedLegacy: toFixedNumber(legacy.totalDeducted, 4),
    totalDeductedShadow: toFixedNumber(shadow.totalDeducted, 4),
    finalEarningsLegacy: toFixedNumber(legacy.finalEarnings, 4),
    finalEarningsShadow: toFixedNumber(shadow.finalEarnings, 4),
    durationMs,
    mismatch: mismatchFields.length > 0,
    mismatchFields,
  };
};

class BillingDomainService {
  private isEnabled(): boolean {
    return featureFlags.billingDomainShadowMode && isRedisConfigured();
  }

  private async incrementMetric(metricName: string, delta = 1): Promise<void> {
    if (!this.isEnabled()) return;
    try {
      const redis = getRedis();
      const key = billingMetricKey(metricName);
      const currentRaw = await redis.get<string>(key);
      const current = metricDeltaFrom(currentRaw);
      await redis.set(key, (current + delta).toString(), {
        ex: SHADOW_REPORT_TTL_SECONDS,
      });
    } catch (error) {
      logger.warn('billing.shadow.metric.increment_failed', { metricName, error });
    }
  }

  async onCallStarted(input: BillingShadowStartInput): Promise<void> {
    if (!this.isEnabled()) return;
    const redis = getRedis();
    const session: BillingShadowSession = {
      ...input,
      startTime: Date.now(),
      elapsedSeconds: 0,
      userCoinsExact: input.startingUserCoins,
      creatorEarningsExact: 0,
    };

    try {
      await redis.set(billingShadowSessionKey(input.callId), JSON.stringify(session), {
        nx: true,
        ex: SHADOW_SESSION_TTL_SECONDS,
      });
    } catch (error) {
      logger.warn('billing.shadow.on_call_started.failed', { callId: input.callId, error });
    }
  }

  async onTick(callId: string): Promise<void> {
    if (!this.isEnabled()) return;
    const redis = getRedis();

    try {
      const lease = await redis.set(billingShadowTickLeaseKey(callId), Date.now().toString(), {
        nx: true,
        ex: SHADOW_TICK_LEASE_SECONDS,
      });
      if (!lease) return;

      const raw = await redis.get<string>(billingShadowSessionKey(callId));
      const session = parseShadowSession(raw);
      if (!session) return;

      session.elapsedSeconds += 1;
      session.userCoinsExact = toFixedNumber(Math.max(0, session.userCoinsExact - session.pricePerSecond));
      session.creatorEarningsExact = toFixedNumber(session.creatorEarningsExact + SHADOW_CREATOR_EARNINGS_PER_SECOND);

      await redis.set(billingShadowSessionKey(callId), JSON.stringify(session), {
        ex: SHADOW_SESSION_TTL_SECONDS,
      });
    } catch (error) {
      logger.warn('billing.shadow.on_tick.failed', { callId, error });
    }
  }

  async recordSettlementConflict(callId: string, reason: string): Promise<void> {
    if (!this.isEnabled()) return;
    await this.incrementMetric('settlement_conflicts');
    logger.warn('billing.shadow.settlement_conflict', { callId, reason });
  }

  async recordSettlementAttempt(): Promise<void> {
    if (!this.isEnabled()) return;
    await this.incrementMetric('settlement_attempts');
  }

  async settleShadowAndCompare(legacy: BillingLegacySettlementSnapshot): Promise<void> {
    if (!this.isEnabled()) return;

    const start = Date.now();
    const redis = getRedis();
    try {
      const auditKey = billingShadowSettleAuditKey(legacy.callId);
      await redis.set(auditKey, JSON.stringify({
        status: 'attempt',
        at: new Date().toISOString(),
      }), {
        ex: SHADOW_REPORT_TTL_SECONDS,
      });

      const lock = await redis.set(billingShadowSettleLockKey(legacy.callId), new Date().toISOString(), {
        nx: true,
        ex: SHADOW_SETTLE_LOCK_TTL_SECONDS,
      });

      if (!lock) {
        await this.recordSettlementConflict(legacy.callId, 'shadow_settle_lock_exists');
        return;
      }

      const raw = await redis.get<string>(billingShadowSessionKey(legacy.callId));
      const session = parseShadowSession(raw);
      const shadowSnapshot: BillingLegacySettlementSnapshot = session
        ? {
            callId: legacy.callId,
            elapsedSeconds: session.elapsedSeconds,
            finalCoins: session.userCoinsExact,
            finalEarnings: session.creatorEarningsExact,
            totalDeducted: toFixedNumber(session.elapsedSeconds * session.pricePerSecond),
          }
        : {
            callId: legacy.callId,
            elapsedSeconds: 0,
            finalCoins: 0,
            finalEarnings: 0,
            totalDeducted: 0,
          };

      const report = compareSettlementSnapshots(legacy, shadowSnapshot, Date.now() - start);
      if (report.mismatch) {
        await this.incrementMetric('balance_mismatch_count');
      }
      await this.incrementMetric('settlement_duration', report.durationMs);

      await redis.set(billingShadowReportKey(legacy.callId), JSON.stringify(report), {
        ex: SHADOW_REPORT_TTL_SECONDS,
      });
      await redis.del(billingShadowSessionKey(legacy.callId));
      await redis.del(billingShadowTickLeaseKey(legacy.callId));

      logger.info('billing.shadow.comparison_report', { ...report });
    } catch (error) {
      logger.error('billing.shadow.settle_compare.failed', {
        callId: legacy.callId,
        error,
      });
    }
  }
}

export const billingDomainService = new BillingDomainService();

