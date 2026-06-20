import {
  getBackpressureMildEventLoopLagMs,
  getBackpressureSustainedEventLoopLagMs,
  getBackpressureSevereEventLoopLagMs,
  getBackpressureMildRedisWriteMs,
  getBackpressureSustainedRedisWriteMs,
  getBackpressureSevereRedisWriteMs,
  getBackpressureMildQueueLagMs,
  getBackpressureSustainedQueueLagMs,
  getBackpressureSevereQueueLagMs,
  getBackpressureMildTickDriftMs,
  getBackpressureSustainedTickDriftMs,
  getBackpressureSevereTickDriftMs,
  getBackpressureSustainedSampleWindow,
  getBackpressureStage2EmitIntervalMs,
  getAdmissionBlockSevereSamples,
} from './billing.constants';
import { recordBillingMetric } from '../../utils/monitoring';
import { getLatestEventLoopLagMs } from '../../utils/runtime-signals';
import { logWarning } from '../../utils/logger';

export type BillingBackpressureStage = 0 | 1 | 2 | 3;

type BackpressureSignals = {
  redisWriteMs?: number;
  queueLagMs?: number;
  tickDriftMs?: number;
};

const state: {
  stage: BillingBackpressureStage;
  sustainedSignals: number;
  consecutiveSevereSamples: number;
  admissionBlocked: boolean;
  lastUpdatedAtMs: number;
} = {
  stage: 0,
  sustainedSignals: 0,
  consecutiveSevereSamples: 0,
  admissionBlocked: false,
  lastUpdatedAtMs: 0,
};

function isAtOrAbove(value: number | undefined, threshold: number): boolean {
  return Number.isFinite(value) && Number(value) >= threshold;
}

function computeSevere(signals: BackpressureSignals): boolean {
  const eventLoopLagMs = getLatestEventLoopLagMs();
  return (
    isAtOrAbove(eventLoopLagMs, getBackpressureSevereEventLoopLagMs()) ||
    isAtOrAbove(signals.redisWriteMs, getBackpressureSevereRedisWriteMs()) ||
    isAtOrAbove(signals.queueLagMs, getBackpressureSevereQueueLagMs()) ||
    isAtOrAbove(signals.tickDriftMs, getBackpressureSevereTickDriftMs())
  );
}

export function isLiveBillingLifecycle(lifecycleState?: string): boolean {
  const lifecycle = String(lifecycleState || 'ACTIVE');
  return lifecycle === 'ACTIVE' || lifecycle === 'STARTING';
}

export function updateBackpressureStage(signals: BackpressureSignals): BillingBackpressureStage {
  const eventLoopLagMs = getLatestEventLoopLagMs();
  const redisWriteMs = signals.redisWriteMs;
  const queueLagMs = signals.queueLagMs;
  const tickDriftMs = signals.tickDriftMs;

  const severe = computeSevere(signals);

  const sustained =
    isAtOrAbove(eventLoopLagMs, getBackpressureSustainedEventLoopLagMs()) ||
    isAtOrAbove(redisWriteMs, getBackpressureSustainedRedisWriteMs()) ||
    isAtOrAbove(queueLagMs, getBackpressureSustainedQueueLagMs()) ||
    isAtOrAbove(tickDriftMs, getBackpressureSustainedTickDriftMs());

  const mild =
    isAtOrAbove(eventLoopLagMs, getBackpressureMildEventLoopLagMs()) ||
    isAtOrAbove(redisWriteMs, getBackpressureMildRedisWriteMs()) ||
    isAtOrAbove(queueLagMs, getBackpressureMildQueueLagMs()) ||
    isAtOrAbove(tickDriftMs, getBackpressureMildTickDriftMs());

  if (severe) {
    state.consecutiveSevereSamples += 1;
  } else {
    state.consecutiveSevereSamples = 0;
  }

  if (sustained) {
    state.sustainedSignals += 1;
  } else {
    state.sustainedSignals = 0;
  }

  const sustainedWindow = getBackpressureSustainedSampleWindow();
  const nextStage: BillingBackpressureStage = severe ? 3 : state.sustainedSignals >= sustainedWindow ? 2 : mild ? 1 : 0;

  if (nextStage !== state.stage) {
    state.stage = nextStage;
    state.lastUpdatedAtMs = Date.now();
    recordBillingMetric('backpressure_stage_changed', nextStage, {
      stage: String(nextStage),
    });
  }

  const threshold = getAdmissionBlockSevereSamples();
  const nextAdmissionBlocked = state.stage >= 3 && state.consecutiveSevereSamples >= threshold;
  if (nextAdmissionBlocked !== state.admissionBlocked) {
    state.admissionBlocked = nextAdmissionBlocked;
    recordBillingMetric('billing_admission_block_active', nextAdmissionBlocked ? 1 : 0, {
      stage: String(state.stage),
      consecutiveSevereSamples: String(state.consecutiveSevereSamples),
      threshold: String(threshold),
    });
    if (nextAdmissionBlocked) {
      logWarning('billing_admission_hysteresis', {
        stage: state.stage,
        consecutiveSevereSamples: state.consecutiveSevereSamples,
        threshold,
        admissionBlocked: true,
      });
    }
  }

  recordBillingMetric('backpressure_stage', state.stage, { stage: String(state.stage) });
  return state.stage;
}

export function getBillingBackpressureStage(): BillingBackpressureStage {
  return state.stage;
}

export function isNewCallAdmissionBlocked(): boolean {
  return state.admissionBlocked;
}

export function getEmitIntervalForStage(normalEmitIntervalMs: number): number {
  return state.stage >= 2
    ? Math.max(normalEmitIntervalMs, getBackpressureStage2EmitIntervalMs())
    : normalEmitIntervalMs;
}

export function resetBackpressureStateForTests(): void {
  state.stage = 0;
  state.sustainedSignals = 0;
  state.consecutiveSevereSamples = 0;
  state.admissionBlocked = false;
  state.lastUpdatedAtMs = 0;
}
