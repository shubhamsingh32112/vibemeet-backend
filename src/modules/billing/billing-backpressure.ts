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
} from './billing.constants';
import { recordBillingMetric } from '../../utils/monitoring';
import { getLatestEventLoopLagMs } from '../../utils/runtime-signals';

export type BillingBackpressureStage = 0 | 1 | 2 | 3;

type BackpressureSignals = {
  redisWriteMs?: number;
  queueLagMs?: number;
  tickDriftMs?: number;
};

const state: {
  stage: BillingBackpressureStage;
  sustainedSignals: number;
  lastUpdatedAtMs: number;
} = {
  stage: 0,
  sustainedSignals: 0,
  lastUpdatedAtMs: 0,
};

function isAtOrAbove(value: number | undefined, threshold: number): boolean {
  return Number.isFinite(value) && Number(value) >= threshold;
}

export function updateBackpressureStage(signals: BackpressureSignals): BillingBackpressureStage {
  const eventLoopLagMs = getLatestEventLoopLagMs();
  const redisWriteMs = signals.redisWriteMs;
  const queueLagMs = signals.queueLagMs;
  const tickDriftMs = signals.tickDriftMs;

  const severe =
    isAtOrAbove(eventLoopLagMs, getBackpressureSevereEventLoopLagMs()) ||
    isAtOrAbove(redisWriteMs, getBackpressureSevereRedisWriteMs()) ||
    isAtOrAbove(queueLagMs, getBackpressureSevereQueueLagMs()) ||
    isAtOrAbove(tickDriftMs, getBackpressureSevereTickDriftMs());

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
  recordBillingMetric('backpressure_stage', state.stage, { stage: String(state.stage) });
  return state.stage;
}

export function getBillingBackpressureStage(): BillingBackpressureStage {
  return state.stage;
}

export function isNewCallAdmissionBlocked(): boolean {
  return state.stage >= 3;
}

export function getEmitIntervalForStage(normalEmitIntervalMs: number): number {
  return state.stage >= 2
    ? Math.max(normalEmitIntervalMs, getBackpressureStage2EmitIntervalMs())
    : normalEmitIntervalMs;
}
