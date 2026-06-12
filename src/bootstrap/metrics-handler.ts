import express from 'express';
import { isRedisConfigured, getRedis, metricsKey, DLQ_BILLING_PREFIX } from '../config/redis';
import { mongoPoolMonitor } from '../utils/mongo-pool-monitor';
import { getRequestQueueStats } from '../middlewares/request-queue.middleware';
import { getDriverMetrics } from '../utils/driver-metrics';
import { monitoring } from '../utils/monitoring';
import { logError } from '../utils/logger';
import { getBillingInstanceId } from '../modules/billing/billing-instance-id';
import { getBillingQueueSnapshot, readBullmqConcurrency } from '../modules/billing/billing.queue';
import { getCreatorFeedRankZcard } from '../modules/creator/creator-feed-rank.service';

export async function metricsRequestHandler(req: express.Request, res: express.Response): Promise<void> {
  try {
    const metricsToken = (process.env.METRICS_TOKEN || '').trim();
    if (metricsToken) {
      const sent = req.headers['x-metrics-token'];
      if (sent !== metricsToken) {
        res.status(403).json({ success: false, error: 'Forbidden' });
        return;
      }
    }
    const mongoStats = mongoPoolMonitor.getStats();
    const queueStats = getRequestQueueStats();
    const driver = getDriverMetrics();
    const metricsSummary = monitoring.getMetricsSummary();
    const byName = metricsSummary.byName;
    const apiSummary = byName['api.latency_ms'];
    const forceTerminateRequested = byName['billing.force_terminate_requested']?.sum ?? 0;
    const forceTerminateFailed = byName['billing.force_terminate_stream_failed']?.sum ?? 0;
    const forceTerminateFailureRate =
      forceTerminateRequested > 0 ? forceTerminateFailed / forceTerminateRequested : 0;
    const bullLagAvgMs = byName['billing.bullmq_queue_lag_ms']?.avg ?? 0;
    const eventLoopLag = byName['system.event_loop_lag_ms'];
    const tickDrift = byName['billing.tick_drift_ms'];
    const settlementTotal = byName['billing.settlement_total_ms'];
    const backpressureStage = byName['billing.backpressure_stage'];
    const stateRecovery = byName['billing.state_recovery'];
    const stateRecoverySuppressed = byName['billing.state_recovery_suppressed'];
    const recoveryOutcome = byName['billing.recovery_outcome'];
    const recoveryRuntimeMissing = byName['billing.recovery_runtime_missing'];
    const billingRuntimeMissingRateMetric = byName['billing.runtime_missing_rate'];
    const deferredCallEndAge = byName['billing.deferred_call_end_age_ms'];
    const deferredCallEndAgeLegacy = byName['billing.deferred_call_end_age'];
    const deferredCallEndQueued = byName['billing.deferred_call_end_queued'];
    const deferredCallEndFlushed = byName['billing.deferred_call_end_flushed'];
    const creatorCanonicalMissingRate =
      byName['call.presence.creator_batch_canonical_missing_rate'];
    const creatorFallbackRate = byName['call.presence.creator_batch_fallback_rate'];
    const creatorCanonicalMissingRateMetric =
      byName['call.creator_presence_canonical_missing_rate'];
    const creatorFallbackRateMetric = byName['call.creator_presence_fallback_rate'];
    const creatorMetaMissingRateMetric = byName['call.presence.creator_meta_missing_rate'];
    const creatorMetaMissingAnyRateMetric = byName['call.presence.creator_meta_missing_any_rate'];
    const creatorMetaMissingExpectedRateMetric = byName['call.presence.creator_meta_missing_expected_rate'];
    const creatorExpectedCanonicalCoverageRateMetric =
      byName['call.presence.creator_expected_canonical_coverage_rate'];
    const creatorMetaParseFailureRateMetric = byName['call.presence.creator_meta_parse_failure_rate'];
    const creatorUidContractViolationRateMetric =
      byName['call.presence.creator_uid_contract_violation_rate'];
    const creatorTransitionRetryMetric = byName['call.presence.creator_transition_retry_count'];
    const creatorStatusPropagation = byName['call.presence.creator_status_propagation_ms'];
    const registryShadowMismatch = byName['call.presence.registry.shadow_mismatch'];
    const registryRegister = byName['call.presence.registry.register'];
    const registryUnregister = byName['call.presence.registry.unregister'];
    const heartbeatLeaseLost = byName['call.presence.heartbeat_lease_lost_before_write'];
    const heartbeatLeaseRenewFailed = byName['call.presence.heartbeat_lease_renew_failed'];
    const graceCallbackSkipped = byName['call.presence.grace_callback_skipped'];
    const heartbeatTtlSkip = byName['call.presence.heartbeat_ttl_skip'];
    const paymentWebhookVerifyFail = byName['payment.webhook.verify_failed'];
    const paymentWebhookVerifySuccess = byName['payment.webhook.verify_success'];
    const paymentWebhookProcessed = byName['payment.webhook.processed'];
    const paymentWebhookProcessFailed = byName['payment.webhook.process_failed'];
    const paymentFinalizeCompleted = byName['payment.finalize.completed'];
    const paymentFinalizeAlreadyCompleted = byName['payment.finalize.already_completed'];
    const paymentFinalizeFailed = byName['payment.finalize.failed'];
    const paymentWebVerifySuccess = byName['payment.web.verify_success'];
    const paymentWebVerifyFailed = byName['payment.web.verify_failed'];
    const paymentWebVerifyDuration = byName['payment.web.verify_duration_ms'];
    const reconRunMsAvg = byName['billing.reconciliation_run_ms']?.avg ?? 0;
    const reconItemsAvg = byName['billing.reconciliation_items_processed']?.avg ?? 0;
    const durableFinalizeDuplicate = byName['billing.billing_finalize_duplicate_prevented'];
    const durablePersistLag = byName['billing.billing_persist_lag_seconds'];
    const durablePendingRecentsAge = byName['billing.call_history_pending_recents_age_seconds'];
    const durableSettlementRetry = byName['billing.billing_settlement_retry_count'];
    const durableStaleFencingReject = byName['billing.billing_stale_fencing_reject_count'];
    const durableLeaseTakeover = byName['billing.billing_lease_takeover_count'];
    const durableReconnectGenMismatch = byName['billing.billing_reconnect_generation_mismatch'];
    const durableLedgerOverlap = byName['billing.billing_ledger_overlap_detected'];
    const durableReconciliationDrift = byName['billing.billing_reconciliation_drift_count'];
    const durableOrphanRecovered = byName['billing.billing_orphaned_sessions_recovered'];
    const durableWatchdogAlert = byName['billing.billing_watchdog_alert_count'];
    const durableLedgerAuthoritative = byName['billing.settlement_ledger_authoritative'];
    const now = Date.now();
    const rollingWindowMs = 5 * 60 * 1000;
    const fromTs = now - rollingWindowMs;
    const rollingSampleLimit = 2000;
    const metricsAlerts: string[] = [];

    let rollingForceTerminateRequested = 0;
    let rollingForceTerminateFailed = 0;
    let rollingForceTerminateFailureRate = 0;
    let rollingBullLagAvgMs = 0;
    let rollingReconRunAvgMs = 0;
    let rollingRedisOpsPerSec = 0;
    let rollingRedisPipelineSuccess = 0;
    let rollingRedisPipelineFailure = 0;
    let rollingRedisPipelineFailureRate = 0;
    let rollingRecoveryRuntimeMissing = 0;
    let rollingDeferredCallEndsQueued = 0;
    let rollingDeferredCallEndsFlushed = 0;
    let rollingCreatorCanonicalMissingRate = 0;
    let rollingCreatorFallbackRate = 0;
    let rollingCreatorMetaMissingRate = 0;
    let rollingCreatorMetaMissingAnyRate = 0;
    let rollingCreatorMetaMissingExpectedRate = 0;
    let rollingCreatorExpectedCanonicalCoverageRate = 0;
    let rollingCreatorMetaParseFailureRate = 0;
    let rollingCreatorUidContractViolationRate = 0;
    let rollingWatchdogLockSkipped5m = 0;
    let rollingWatchdogLockAcquired5m = 0;
    let rollingReconLockSkipped5m = 0;
    let rollingCycleLockDeferred5m = 0;
    let dlqSize = 0;
    let bullmqQueueSnapshot: Awaited<ReturnType<typeof getBillingQueueSnapshot>> = null;
    let feedRankZcard = 0;

    if (isRedisConfigured()) {
      const redis = getRedis();
      const [requested5m, failed5m] = await Promise.all([
        redis.zcount(metricsKey('billing.force_terminate_requested'), fromTs, now),
        redis.zcount(metricsKey('billing.force_terminate_stream_failed'), fromTs, now),
      ]);
      rollingForceTerminateRequested = Number(requested5m || 0);
      rollingForceTerminateFailed = Number(failed5m || 0);
      rollingForceTerminateFailureRate =
        rollingForceTerminateRequested > 0
          ? rollingForceTerminateFailed / rollingForceTerminateRequested
          : 0;

      const [
        lagSampleRaw,
        reconSampleRaw,
        redisOpsRaw,
        pipelineSuccess5m,
        pipelineFailure5m,
        recoveryRuntimeMissing5m,
        deferredQueued5m,
        deferredFlushed5m,
        creatorCanonicalMissingRaw,
        creatorFallbackRaw,
        creatorMetaMissingRaw,
        creatorMetaMissingAnyRaw,
        creatorMetaMissingExpectedRaw,
        creatorExpectedCoverageRaw,
        creatorMetaParseFailureRaw,
        creatorUidViolationRaw,
        watchdogSkipped5m,
        watchdogAcquired5m,
        reconSkipped5m,
        cycleLockDeferred5m,
        dlqSizeRaw,
        queueSnapshot,
        rankZcard,
      ] = await Promise.all([
        redis.zrevrangebyscore(
          metricsKey('billing.bullmq_queue_lag_ms'),
          now,
          fromTs,
          'LIMIT',
          0,
          rollingSampleLimit
        ),
        redis.zrevrangebyscore(
          metricsKey('billing.reconciliation_run_ms'),
          now,
          fromTs,
          'LIMIT',
          0,
          rollingSampleLimit
        ),
        redis.zrevrangebyscore(
          metricsKey('billing.redis_ops'),
          now,
          fromTs,
          'LIMIT',
          0,
          rollingSampleLimit
        ),
        redis.zcount(metricsKey('billing.redis_pipeline_success'), fromTs, now),
        redis.zcount(metricsKey('billing.redis_pipeline_failure'), fromTs, now),
        redis.zcount(metricsKey('billing.recovery_runtime_missing'), fromTs, now),
        redis.zcount(metricsKey('billing.deferred_call_end_queued'), fromTs, now),
        redis.zcount(metricsKey('billing.deferred_call_end_flushed'), fromTs, now),
        redis.zrevrangebyscore(
          metricsKey('call.presence.creator_batch_canonical_missing_rate'),
          now,
          fromTs,
          'LIMIT',
          0,
          rollingSampleLimit
        ),
        redis.zrevrangebyscore(
          metricsKey('call.presence.creator_batch_fallback_rate'),
          now,
          fromTs,
          'LIMIT',
          0,
          rollingSampleLimit
        ),
        redis.zrevrangebyscore(
          metricsKey('call.presence.creator_meta_missing_rate'),
          now,
          fromTs,
          'LIMIT',
          0,
          rollingSampleLimit
        ),
        redis.zrevrangebyscore(
          metricsKey('call.presence.creator_meta_missing_any_rate'),
          now,
          fromTs,
          'LIMIT',
          0,
          rollingSampleLimit
        ),
        redis.zrevrangebyscore(
          metricsKey('call.presence.creator_meta_missing_expected_rate'),
          now,
          fromTs,
          'LIMIT',
          0,
          rollingSampleLimit
        ),
        redis.zrevrangebyscore(
          metricsKey('call.presence.creator_expected_canonical_coverage_rate'),
          now,
          fromTs,
          'LIMIT',
          0,
          rollingSampleLimit
        ),
        redis.zrevrangebyscore(
          metricsKey('call.presence.creator_meta_parse_failure_rate'),
          now,
          fromTs,
          'LIMIT',
          0,
          rollingSampleLimit
        ),
        redis.zrevrangebyscore(
          metricsKey('call.presence.creator_uid_contract_violation_rate'),
          now,
          fromTs,
          'LIMIT',
          0,
          rollingSampleLimit
        ),
        redis.zcount(metricsKey('billing.billing.watchdog.lock_skipped'), fromTs, now),
        redis.zcount(metricsKey('billing.billing.watchdog.lock_acquired'), fromTs, now),
        redis.zcount(metricsKey('billing.reconciliation_skipped_lock_busy'), fromTs, now),
        redis.zcount(metricsKey('billing.billing_cycle_lock_deferred'), fromTs, now),
        redis.scard(`${DLQ_BILLING_PREFIX}set`),
        getBillingQueueSnapshot(),
        getCreatorFeedRankZcard(),
      ]);

      dlqSize = Number(dlqSizeRaw || 0);
      bullmqQueueSnapshot = queueSnapshot;
      feedRankZcard = Number(rankZcard || 0);
      rollingWatchdogLockSkipped5m = Number(watchdogSkipped5m || 0);
      rollingWatchdogLockAcquired5m = Number(watchdogAcquired5m || 0);
      rollingReconLockSkipped5m = Number(reconSkipped5m || 0);
      rollingCycleLockDeferred5m = Number(cycleLockDeferred5m || 0);

      const parseMetricSampleStats = (raw: string[]): { avg: number; sum: number; count: number } => {
        if (!raw || raw.length === 0) return { avg: 0, sum: 0, count: 0 };
        let sum = 0;
        let count = 0;
        for (const item of raw) {
          try {
            const parsed = JSON.parse(item) as { value?: number };
            const v = Number(parsed.value);
            if (Number.isFinite(v)) {
              sum += v;
              count += 1;
            }
          } catch {
            // ignore malformed sample
          }
        }
        return {
          avg: count > 0 ? sum / count : 0,
          sum,
          count,
        };
      };

      const lagStats = parseMetricSampleStats(lagSampleRaw);
      const reconStats = parseMetricSampleStats(reconSampleRaw);
      const redisOpsStats = parseMetricSampleStats(redisOpsRaw);
      rollingBullLagAvgMs = lagStats.avg;
      rollingReconRunAvgMs = reconStats.avg;
      rollingRedisOpsPerSec = redisOpsStats.sum / (rollingWindowMs / 1000);
      rollingRedisPipelineSuccess = Number(pipelineSuccess5m || 0);
      rollingRedisPipelineFailure = Number(pipelineFailure5m || 0);
      rollingRecoveryRuntimeMissing = Number(recoveryRuntimeMissing5m || 0);
      rollingDeferredCallEndsQueued = Number(deferredQueued5m || 0);
      rollingDeferredCallEndsFlushed = Number(deferredFlushed5m || 0);
      const creatorCanonicalMissingStats = parseMetricSampleStats(creatorCanonicalMissingRaw);
      const creatorFallbackStats = parseMetricSampleStats(creatorFallbackRaw);
      const creatorMetaMissingStats = parseMetricSampleStats(creatorMetaMissingRaw);
      const creatorMetaMissingAnyStats = parseMetricSampleStats(creatorMetaMissingAnyRaw);
      const creatorMetaMissingExpectedStats = parseMetricSampleStats(creatorMetaMissingExpectedRaw);
      const creatorExpectedCoverageStats = parseMetricSampleStats(creatorExpectedCoverageRaw);
      const creatorMetaParseFailureStats = parseMetricSampleStats(creatorMetaParseFailureRaw);
      const creatorUidViolationStats = parseMetricSampleStats(creatorUidViolationRaw);
      rollingCreatorCanonicalMissingRate = creatorCanonicalMissingStats.avg;
      rollingCreatorFallbackRate = creatorFallbackStats.avg;
      rollingCreatorMetaMissingRate = creatorMetaMissingStats.avg;
      rollingCreatorMetaMissingAnyRate = creatorMetaMissingAnyStats.avg;
      rollingCreatorMetaMissingExpectedRate = creatorMetaMissingExpectedStats.avg;
      rollingCreatorExpectedCanonicalCoverageRate = creatorExpectedCoverageStats.avg;
      rollingCreatorMetaParseFailureRate = creatorMetaParseFailureStats.avg;
      rollingCreatorUidContractViolationRate = creatorUidViolationStats.avg;
      const totalPipelines = rollingRedisPipelineSuccess + rollingRedisPipelineFailure;
      rollingRedisPipelineFailureRate =
        totalPipelines > 0 ? rollingRedisPipelineFailure / totalPipelines : 0;
    }

    if (rollingForceTerminateRequested > 0 && rollingForceTerminateFailureRate > 0.02) {
      metricsAlerts.push('billing_force_termination_failure_rate_high_5m');
    }
    if (rollingBullLagAvgMs > 5000) {
      metricsAlerts.push('bullmq_queue_lag_high_5m');
    }
    if ((eventLoopLag?.p95 ?? 0) > 50) {
      metricsAlerts.push('event_loop_lag_p95_high');
    }
    if ((tickDrift?.p95 ?? 0) > 100 || (tickDrift?.p99 ?? 0) > 300) {
      metricsAlerts.push('billing_tick_drift_high');
    }
    if ((backpressureStage?.max ?? 0) >= 3) {
      metricsAlerts.push('billing_backpressure_stage3');
    }
    const recoverySuccess = stateRecovery?.sum ?? 0;
    const recoverySuppressed = stateRecoverySuppressed?.sum ?? 0;
    const recoveryTotal = recoverySuccess + recoverySuppressed;
    if (recoveryTotal >= 20 && recoverySuppressed / recoveryTotal > 0.85) {
      metricsAlerts.push('billing_recovery_suppressed_high');
    }
    if ((settlementTotal?.p95 ?? 0) > 5000) {
      metricsAlerts.push('billing_settlement_p95_high');
    }
    if (dlqSize > 50) {
      metricsAlerts.push('billing_dlq_size_high');
    }
    if (
      rollingWatchdogLockAcquired5m > 0 &&
      rollingWatchdogLockSkipped5m / rollingWatchdogLockAcquired5m > 0.3
    ) {
      metricsAlerts.push('billing_watchdog_lock_contention_high');
    }
    const delayedJobs = bullmqQueueSnapshot?.delayed ?? byName['billing.bullmq_cycle_jobs_delayed']?.max ?? 0;
    const activeJobs = bullmqQueueSnapshot?.active ?? byName['billing.bullmq_cycle_jobs_active']?.max ?? 0;
    if (Number(delayedJobs) > Math.max(100, Number(activeJobs) * 2)) {
      metricsAlerts.push('billing_queue_depth_high');
    }
    if ((creatorStatusPropagation?.p95 ?? 0) > 500) {
      metricsAlerts.push('creator_status_propagation_high');
    }
    if (rollingRedisPipelineFailureRate > 0.02) {
      metricsAlerts.push('billing_redis_pipeline_failure_rate_high_5m');
    }
    if (rollingReconRunAvgMs > 0 && rollingReconRunAvgMs > 0.8 * 5 * 60 * 1000) {
      metricsAlerts.push('billing_reconciliation_runtime_high_5m');
    }
    if (rollingRecoveryRuntimeMissing >= 5) {
      metricsAlerts.push('billing_runtime_missing_detected_5m');
    }
    if (rollingDeferredCallEndsQueued > 0 && rollingDeferredCallEndsFlushed < rollingDeferredCallEndsQueued) {
      metricsAlerts.push('billing_deferred_call_end_backlog_5m');
    }
    if (rollingCreatorCanonicalMissingRate > 0.05) {
      metricsAlerts.push('creator_presence_canonical_missing_high_5m');
    }
    if (rollingCreatorFallbackRate > 0.05) {
      metricsAlerts.push('creator_presence_fallback_high_5m');
    }
    if (rollingCreatorMetaMissingRate > 0.05) {
      metricsAlerts.push('creator_presence_meta_missing_high_5m');
    }
    if (rollingCreatorMetaParseFailureRate > 0.01) {
      metricsAlerts.push('creator_presence_meta_parse_failure_high_5m');
    }
    if (rollingCreatorUidContractViolationRate > 0.005) {
      metricsAlerts.push('creator_presence_uid_contract_violation_high_5m');
    }
    if ((durablePersistLag?.p95 ?? 0) > 10) {
      metricsAlerts.push('billing_persist_lag_p95_high');
    }
    if ((durableLedgerOverlap?.count ?? 0) > 0) {
      metricsAlerts.push('billing_ledger_overlap_detected');
    }
    if ((durableStaleFencingReject?.count ?? 0) >= 5) {
      metricsAlerts.push('billing_stale_fencing_reject_elevated');
    }
    if ((durableReconciliationDrift?.count ?? 0) >= 3) {
      metricsAlerts.push('billing_reconciliation_drift_elevated');
    }

    const fanoutDuration = byName['stream.feed.fanout.duration_ms'];
    const fanoutFailed = byName['stream.feed.fanout.failed']?.sum ?? 0;
    const cfBreakerOpen = byName['stream.cloudflare.breaker_open']?.sum ?? 0;
    let momentsFanoutQueueDepth = byName['stream.feed.fanout.queue_depth']?.max ?? 0;
    let momentsWarmQueueDepth = byName['stream.feed.warm.queue_depth']?.max ?? 0;
    if (isRedisConfigured()) {
      const redis = getRedis();
      const [fanoutLen, warmLen] = await Promise.all([
        redis.llen('moments:fanout:queue'),
        redis.llen('moments:feed:warm:queue'),
      ]);
      momentsFanoutQueueDepth = Math.max(momentsFanoutQueueDepth, Number(fanoutLen || 0));
      momentsWarmQueueDepth = Math.max(momentsWarmQueueDepth, Number(warmLen || 0));
    }
    const fanoutQueueThreshold = Number(process.env.MOMENTS_FANOUT_QUEUE_ALERT_DEPTH || 500);
    if (momentsFanoutQueueDepth > fanoutQueueThreshold) {
      metricsAlerts.push('moments_fanout_queue_depth_high');
    }
    if ((fanoutDuration?.p95 ?? 0) > 120_000) {
      metricsAlerts.push('moments_fanout_duration_p95_high');
    }
    if (fanoutFailed >= 10) {
      metricsAlerts.push('moments_fanout_failed_high');
    }
    if (cfBreakerOpen >= 5) {
      metricsAlerts.push('cloudflare_stream_breaker_open_high');
    }

    const hardBlockerAlertKeys = new Set([
      'billing_runtime_missing_detected_5m',
      'billing_deferred_call_end_backlog_5m',
    ]);
    const hardBlockerAlerts = metricsAlerts.filter((alert) => hardBlockerAlertKeys.has(alert));

    res.status(200).json({
      mongo: {
        activeConnections: mongoStats.checkedOut,
        maxConnections: mongoStats.maxPoolSize,
        poolUtilization: Math.round(mongoStats.utilization * 100) / 100,
        checkOutFailedTotal: mongoStats.checkOutFailedTotal,
        lastCheckOutFailedAt: mongoStats.lastCheckOutFailedAt,
        driverConnectionErrors: driver.mongo.connectionErrors,
      },
      redis: {
        driverErrors: driver.redis.errors,
        driverCloses: driver.redis.closes,
      },
      requestQueue: {
        active: queueStats.active,
        waiting: queueStats.waiting,
        rejected: queueStats.rejected,
      },
      api: {
        latencyMs: apiSummary
          ? {
              samples: apiSummary.count,
              avgMs: Math.round((apiSummary.sum / apiSummary.count) * 100) / 100,
            }
          : null,
        http5xxSamples: byName['api.http_5xx']?.count ?? 0,
      },
      billing: {
        backpressure: {
          currentStage: Math.round(backpressureStage?.max ?? 0),
        },
        recovery: {
          stateRecoverySamples: stateRecovery?.count ?? 0,
          stateRecoverySuccessSum: recoverySuccess,
          stateRecoverySuppressedSamples: stateRecoverySuppressed?.count ?? 0,
          stateRecoverySuppressedSum: recoverySuppressed,
          recoveryOutcomeSamples: recoveryOutcome?.count ?? 0,
          runtimeMissingSamples: recoveryRuntimeMissing?.count ?? 0,
          runtimeMissingRateSamples: billingRuntimeMissingRateMetric?.count ?? 0,
          rolling5mRuntimeMissingSamples: rollingRecoveryRuntimeMissing,
          billing_runtime_missing_rate:
            Math.round((rollingRecoveryRuntimeMissing / (rollingWindowMs / 1000)) * 1000) / 1000,
        },
        integrity: {
          balanceMismatchSamples: byName['billing.balance_mismatch_total']?.count ?? 0,
          balanceMismatchRepairEnqueued:
            byName['billing.balance_mismatch_repair_enqueued_total']?.count ?? 0,
          balanceMismatchRepairApplied:
            byName['billing.balance_mismatch_repair_applied_total']?.count ?? 0,
          finalizeConvergenceRetries:
            byName['billing.billing_finalize_convergence_retry_total']?.count ?? 0,
        },
        deferredCallEnd: {
          queuedSamples: deferredCallEndQueued?.count ?? 0,
          flushedSamples: deferredCallEndFlushed?.count ?? 0,
          ageMs: deferredCallEndAge
            ? {
                samples: deferredCallEndAge.count,
                avgMs: Math.round(deferredCallEndAge.avg * 100) / 100,
                p95Ms: Math.round(deferredCallEndAge.p95 * 100) / 100,
                p99Ms: Math.round(deferredCallEndAge.p99 * 100) / 100,
                maxMs: Math.round(deferredCallEndAge.max * 100) / 100,
              }
            : null,
          deferred_call_end_age: deferredCallEndAgeLegacy
            ? {
                samples: deferredCallEndAgeLegacy.count,
                avg: Math.round(deferredCallEndAgeLegacy.avg * 100) / 100,
              }
            : null,
          rolling5m: {
            queued: rollingDeferredCallEndsQueued,
            flushed: rollingDeferredCallEndsFlushed,
          },
        },
        tickDriftMs: tickDrift
          ? {
              samples: tickDrift.count,
              avgMs: Math.round(tickDrift.avg * 100) / 100,
              p95Ms: Math.round(tickDrift.p95 * 100) / 100,
              p99Ms: Math.round(tickDrift.p99 * 100) / 100,
              maxMs: Math.round(tickDrift.max * 100) / 100,
            }
          : null,
        settlementTotalMs: settlementTotal
          ? {
              samples: settlementTotal.count,
              avgMs: Math.round(settlementTotal.avg * 100) / 100,
              p95Ms: Math.round(settlementTotal.p95 * 100) / 100,
              p99Ms: Math.round(settlementTotal.p99 * 100) / 100,
              maxMs: Math.round(settlementTotal.max * 100) / 100,
            }
          : null,
        forceTermination: {
          requested: forceTerminateRequested,
          streamFailures: forceTerminateFailed,
          failureRate: Math.round(forceTerminateFailureRate * 10000) / 10000,
          rolling5m: {
            requested: rollingForceTerminateRequested,
            streamFailures: rollingForceTerminateFailed,
            failureRate:
              Math.round(rollingForceTerminateFailureRate * 10000) / 10000,
          },
        },
        streamMarkEnded: {
          samples: byName['billing.stream_mark_ended_result_total']?.count ?? 0,
        },
        instanceId: getBillingInstanceId(),
        dlq: {
          size: dlqSize,
          batchFetchP95Ms: byName['billing.dlq_batch_fetch_ms']?.p95 ?? 0,
        },
        locks: {
          watchdogSkipped5m: rollingWatchdogLockSkipped5m,
          watchdogAcquired5m: rollingWatchdogLockAcquired5m,
          reconSkipped5m: rollingReconLockSkipped5m,
          cycleLockDeferred5m: rollingCycleLockDeferred5m,
        },
        runtime: {
          eventLoopLagP95: Math.round((eventLoopLag?.p95 ?? 0) * 100) / 100,
        },
        bullmq: {
          queueLagAvgMs: Math.round(bullLagAvgMs * 100) / 100,
          queueLagSamples: byName['billing.bullmq_queue_lag_ms']?.count ?? 0,
          jobsActive: bullmqQueueSnapshot?.active ?? byName['billing.bullmq_cycle_jobs_active']?.max ?? 0,
          jobsWaiting: bullmqQueueSnapshot?.waiting ?? byName['billing.bullmq_cycle_jobs_waiting']?.max ?? 0,
          jobsDelayed: bullmqQueueSnapshot?.delayed ?? byName['billing.bullmq_cycle_jobs_delayed']?.max ?? 0,
          concurrency: bullmqQueueSnapshot?.concurrency ?? readBullmqConcurrency(),
          rolling5m: {
            queueLagAvgMs: Math.round(rollingBullLagAvgMs * 100) / 100,
            sampleLimit: rollingSampleLimit,
          },
        },
        redis: {
          opsPerSecRolling5m: Math.round(rollingRedisOpsPerSec * 100) / 100,
          pipelineRolling5m: {
            success: rollingRedisPipelineSuccess,
            failure: rollingRedisPipelineFailure,
            failureRate: Math.round(rollingRedisPipelineFailureRate * 10000) / 10000,
          },
        },
        reconciliation: {
          runAvgMs: Math.round(reconRunMsAvg * 100) / 100,
          runSamples: byName['billing.reconciliation_run_ms']?.count ?? 0,
          itemsAvg: Math.round(reconItemsAvg * 100) / 100,
          rolling5m: {
            runAvgMs: Math.round(rollingReconRunAvgMs * 100) / 100,
            sampleLimit: rollingSampleLimit,
          },
        },
        durableCallSession: {
          finalizeDuplicatePrevented: durableFinalizeDuplicate?.count ?? 0,
          persistLagSeconds: durablePersistLag
            ? {
                samples: durablePersistLag.count,
                avg: Math.round(durablePersistLag.avg * 100) / 100,
                p95: Math.round(durablePersistLag.p95 * 100) / 100,
                max: Math.round(durablePersistLag.max * 100) / 100,
              }
            : null,
          pendingRecentsAgeSeconds: durablePendingRecentsAge
            ? {
                samples: durablePendingRecentsAge.count,
                avg: Math.round(durablePendingRecentsAge.avg * 100) / 100,
                p95: Math.round(durablePendingRecentsAge.p95 * 100) / 100,
                max: Math.round(durablePendingRecentsAge.max * 100) / 100,
              }
            : null,
          settlementRetryCount: durableSettlementRetry?.count ?? 0,
          staleFencingRejectCount: durableStaleFencingReject?.count ?? 0,
          leaseTakeoverCount: durableLeaseTakeover?.count ?? 0,
          reconnectGenerationMismatch: durableReconnectGenMismatch?.count ?? 0,
          ledgerOverlapDetected: durableLedgerOverlap?.count ?? 0,
          reconciliationDriftCount: durableReconciliationDrift?.count ?? 0,
          orphanedSessionsRecovered: durableOrphanRecovered?.count ?? 0,
          watchdogAlertCount: durableWatchdogAlert?.count ?? 0,
          settlementLedgerAuthoritative: durableLedgerAuthoritative?.count ?? 0,
        },
      },
      payment: {
        webhook: {
          verify: {
            successSamples: paymentWebhookVerifySuccess?.count ?? 0,
            failedSamples: paymentWebhookVerifyFail?.count ?? 0,
          },
          processing: {
            processedSamples: paymentWebhookProcessed?.count ?? 0,
            failedSamples: paymentWebhookProcessFailed?.count ?? 0,
          },
        },
        finalize: {
          completedSamples: paymentFinalizeCompleted?.count ?? 0,
          alreadyCompletedSamples: paymentFinalizeAlreadyCompleted?.count ?? 0,
          failedSamples: paymentFinalizeFailed?.count ?? 0,
        },
        webVerify: {
          successSamples: paymentWebVerifySuccess?.count ?? 0,
          failedSamples: paymentWebVerifyFailed?.count ?? 0,
          durationMs: paymentWebVerifyDuration
            ? {
                samples: paymentWebVerifyDuration.count,
                avgMs: Math.round(paymentWebVerifyDuration.avg * 100) / 100,
                p95Ms: Math.round(paymentWebVerifyDuration.p95 * 100) / 100,
                p99Ms: Math.round(paymentWebVerifyDuration.p99 * 100) / 100,
                maxMs: Math.round(paymentWebVerifyDuration.max * 100) / 100,
              }
            : null,
        },
      },
      runtime: {
        eventLoopLagMs: eventLoopLag
          ? {
              samples: eventLoopLag.count,
              avgMs: Math.round(eventLoopLag.avg * 100) / 100,
              p95Ms: Math.round(eventLoopLag.p95 * 100) / 100,
              p99Ms: Math.round(eventLoopLag.p99 * 100) / 100,
              maxMs: Math.round(eventLoopLag.max * 100) / 100,
            }
          : null,
      },
      presence: {
        feedRankZcard: feedRankZcard,
        registryShadowMismatch: registryShadowMismatch?.sum ?? 0,
        registryRegister: registryRegister?.sum ?? 0,
        registryUnregister: registryUnregister?.sum ?? 0,
        heartbeatLeaseLostBeforeWrite: heartbeatLeaseLost?.sum ?? 0,
        heartbeatLeaseRenewFailed: heartbeatLeaseRenewFailed?.sum ?? 0,
        graceCallbackSkipped: graceCallbackSkipped?.sum ?? 0,
        heartbeatTtlSkip: heartbeatTtlSkip?.sum ?? 0,
        creatorStatusPropagationMs: creatorStatusPropagation
          ? {
              samples: creatorStatusPropagation.count,
              avgMs: Math.round(creatorStatusPropagation.avg * 100) / 100,
              p95Ms: Math.round(creatorStatusPropagation.p95 * 100) / 100,
              p99Ms: Math.round(creatorStatusPropagation.p99 * 100) / 100,
              maxMs: Math.round(creatorStatusPropagation.max * 100) / 100,
            }
          : null,
        creatorCanonicalMissingRate: creatorCanonicalMissingRate
          ? {
              samples: creatorCanonicalMissingRate.count,
              avgRate: Math.round(creatorCanonicalMissingRate.avg * 10000) / 10000,
              p95Rate: Math.round(creatorCanonicalMissingRate.p95 * 10000) / 10000,
              p99Rate: Math.round(creatorCanonicalMissingRate.p99 * 10000) / 10000,
              maxRate: Math.round(creatorCanonicalMissingRate.max * 10000) / 10000,
              rolling5mAvgRate: Math.round(rollingCreatorCanonicalMissingRate * 10000) / 10000,
            }
          : null,
        creator_presence_canonical_missing_rate: creatorCanonicalMissingRateMetric
          ? {
              samples: creatorCanonicalMissingRateMetric.count,
              avgRate: Math.round(creatorCanonicalMissingRateMetric.avg * 10000) / 10000,
              rolling5mAvgRate: Math.round(rollingCreatorCanonicalMissingRate * 10000) / 10000,
            }
          : null,
        creatorFallbackRate: creatorFallbackRate
          ? {
              samples: creatorFallbackRate.count,
              avgRate: Math.round(creatorFallbackRate.avg * 10000) / 10000,
              p95Rate: Math.round(creatorFallbackRate.p95 * 10000) / 10000,
              p99Rate: Math.round(creatorFallbackRate.p99 * 10000) / 10000,
              maxRate: Math.round(creatorFallbackRate.max * 10000) / 10000,
              rolling5mAvgRate: Math.round(rollingCreatorFallbackRate * 10000) / 10000,
            }
          : null,
        creator_presence_fallback_rate: creatorFallbackRateMetric
          ? {
              samples: creatorFallbackRateMetric.count,
              avgRate: Math.round(creatorFallbackRateMetric.avg * 10000) / 10000,
              rolling5mAvgRate: Math.round(rollingCreatorFallbackRate * 10000) / 10000,
            }
          : null,
        creatorMetaMissingRate: creatorMetaMissingRateMetric
          ? {
              samples: creatorMetaMissingRateMetric.count,
              avgRate: Math.round(creatorMetaMissingRateMetric.avg * 10000) / 10000,
              rolling5mAvgRate: Math.round(rollingCreatorMetaMissingRate * 10000) / 10000,
            }
          : null,
        creatorMetaMissingAnyRate: creatorMetaMissingAnyRateMetric
          ? {
              samples: creatorMetaMissingAnyRateMetric.count,
              avgRate: Math.round(creatorMetaMissingAnyRateMetric.avg * 10000) / 10000,
              rolling5mAvgRate: Math.round(rollingCreatorMetaMissingAnyRate * 10000) / 10000,
            }
          : null,
        creatorMetaMissingExpectedRate: creatorMetaMissingExpectedRateMetric
          ? {
              samples: creatorMetaMissingExpectedRateMetric.count,
              avgRate: Math.round(creatorMetaMissingExpectedRateMetric.avg * 10000) / 10000,
              rolling5mAvgRate: Math.round(rollingCreatorMetaMissingExpectedRate * 10000) / 10000,
            }
          : null,
        creatorExpectedCanonicalCoverageRate: creatorExpectedCanonicalCoverageRateMetric
          ? {
              samples: creatorExpectedCanonicalCoverageRateMetric.count,
              avgRate: Math.round(creatorExpectedCanonicalCoverageRateMetric.avg * 10000) / 10000,
              rolling5mAvgRate: Math.round(rollingCreatorExpectedCanonicalCoverageRate * 10000) / 10000,
            }
          : null,
        creatorMetaParseFailureRate: creatorMetaParseFailureRateMetric
          ? {
              samples: creatorMetaParseFailureRateMetric.count,
              avgRate: Math.round(creatorMetaParseFailureRateMetric.avg * 10000) / 10000,
              rolling5mAvgRate: Math.round(rollingCreatorMetaParseFailureRate * 10000) / 10000,
            }
          : null,
        creatorUidContractViolationRate: creatorUidContractViolationRateMetric
          ? {
              samples: creatorUidContractViolationRateMetric.count,
              avgRate: Math.round(creatorUidContractViolationRateMetric.avg * 10000) / 10000,
              rolling5mAvgRate: Math.round(rollingCreatorUidContractViolationRate * 10000) / 10000,
            }
          : null,
        creatorTransitionRetryCount: creatorTransitionRetryMetric
          ? {
              samples: creatorTransitionRetryMetric.count,
              avgRetries: Math.round(creatorTransitionRetryMetric.avg * 100) / 100,
              maxRetries: Math.round(creatorTransitionRetryMetric.max * 100) / 100,
            }
          : null,
      },
      moments: {
        fanout: {
          queueDepth: momentsFanoutQueueDepth,
          durationMs: fanoutDuration
            ? {
                samples: fanoutDuration.count,
                avgMs: Math.round(fanoutDuration.avg * 100) / 100,
                p95Ms: Math.round(fanoutDuration.p95 * 100) / 100,
              }
            : null,
          failedSum: fanoutFailed,
        },
        warm: {
          queueDepth: momentsWarmQueueDepth,
          failedSum: byName['stream.feed.warm.failed']?.sum ?? 0,
        },
        cloudflare: {
          breakerOpenSum: cfBreakerOpen,
        },
        playback: {
          tokenRefreshFailSum: byName['video.playback.token_refresh_fail']?.sum ?? 0,
          playerErrorSum: byName['video.playback.player_error']?.sum ?? 0,
          startupP95Ms: Math.round((byName['video.playback.startup_ms']?.p95 ?? 0) * 100) / 100,
        },
      },
      alerts: {
        active: metricsAlerts,
        blockers: hardBlockerAlerts,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    logError('Metrics endpoint error', err);
    res.status(500).json({ error: 'Failed to collect metrics' });
  }
}

export function registerMetricsRoute(app: express.Application): void {
  app.get('/metrics', metricsRequestHandler);
}
