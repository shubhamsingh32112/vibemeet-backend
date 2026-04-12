/**
 * Integer coin micros: 1 display coin = COIN_MICROS micro-coins.
 * All in-call Redis billing math uses these micros (no floats on the hot path).
 */
export const COIN_MICROS = 1_000_000;

/** How often the ZSET scheduler wakes a call for processing (ms). */
export const BILLING_PROCESS_INTERVAL_MS = 300;

const DEFAULT_MAX_BILLING_DELTA_MS = 5000;
const MIN_MAX_BILLING_DELTA_MS = 500;
const ABS_MAX_BILLING_DELTA_MS = 60_000;

/**
 * Max wall-clock gap applied in one cycle (bounds damage if the processor stalls).
 * Override with env `MAX_BILLING_DELTA_MS` (clamped between 500 and 60000).
 */
function readMaxBillingDeltaMs(): number {
  const raw = process.env.MAX_BILLING_DELTA_MS;
  if (raw === undefined || raw === '') {
    return DEFAULT_MAX_BILLING_DELTA_MS;
  }
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) {
    return DEFAULT_MAX_BILLING_DELTA_MS;
  }
  return Math.min(ABS_MAX_BILLING_DELTA_MS, Math.max(MIN_MAX_BILLING_DELTA_MS, n));
}

export const MAX_BILLING_DELTA_MS = readMaxBillingDeltaMs();

/** Skip cycles shorter than this (ms) to reduce churn. */
export const MIN_BILLING_DELTA_MS = 50;

/** How often to extend the per-call billing lock while a cycle runs. */
export const BILLING_CYCLE_LOCK_HEARTBEAT_MS = 500;

const DEFAULT_BILLING_CYCLE_LOCK_TTL_MS = 3500;
const MIN_BILLING_CYCLE_LOCK_TTL_MS = BILLING_CYCLE_LOCK_HEARTBEAT_MS * 2;
const MAX_BILLING_CYCLE_LOCK_TTL_MS = 10_000;

/**
 * Initial lock TTL (ms); heartbeat extends with PX + XX.
 * Override with env `BILLING_CYCLE_LOCK_TTL_MS` (clamped between 2× heartbeat and 10000).
 */
function readBillingCycleLockTtlMs(): number {
  const raw = process.env.BILLING_CYCLE_LOCK_TTL_MS;
  if (raw === undefined || raw === '') {
    return DEFAULT_BILLING_CYCLE_LOCK_TTL_MS;
  }
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) {
    return DEFAULT_BILLING_CYCLE_LOCK_TTL_MS;
  }
  return Math.min(
    MAX_BILLING_CYCLE_LOCK_TTL_MS,
    Math.max(MIN_BILLING_CYCLE_LOCK_TTL_MS, n)
  );
}

export const BILLING_CYCLE_LOCK_TTL_MS = readBillingCycleLockTtlMs();

export const BILLING_SESSION_SCHEMA_VERSION = 2;

/** Minimum checkpoint interval clamp (ms). */
const MIN_BILLING_CHECKPOINT_INTERVAL_MS = 10_000;

/** Optional Mongo checkpoint for in-flight billing (0 = disabled). */
export function getBillingCheckpointIntervalMs(): number {
  const raw = process.env.BILLING_CHECKPOINT_INTERVAL_MS;
  if (raw === undefined || raw === '') return 0;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(300_000, Math.max(MIN_BILLING_CHECKPOINT_INTERVAL_MS, n));
}

const DEFAULT_BILLING_CHECKPOINT_MIN_DELTA_MICROS = 1_000_000;

/**
 * Minimum change in deducted or earned micros since last checkpoint to upsert (0 = time-only gating).
 * Default 1 whole coin in micros. Set `BILLING_CHECKPOINT_MIN_DELTA_MICROS=0` to disable the delta gate.
 */
export function getBillingCheckpointMinDeltaMicros(): number {
  const raw = process.env.BILLING_CHECKPOINT_MIN_DELTA_MICROS;
  if (raw === undefined || raw === '') {
    return DEFAULT_BILLING_CHECKPOINT_MIN_DELTA_MICROS;
  }
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) {
    return DEFAULT_BILLING_CHECKPOINT_MIN_DELTA_MICROS;
  }
  return n;
}

export function coinsWholeToMicros(coinsWhole: number): number {
  return Math.round(Number(coinsWhole) * COIN_MICROS);
}

export function microsToWholeCoinsFloor(micros: number): number {
  if (!Number.isFinite(micros) || micros <= 0) return 0;
  return Math.floor(micros / COIN_MICROS);
}

/**
 * Legacy symmetric rounding; prefer debit/credit/remainder helpers for settlement.
 */
export function microsToSettlementCoins(micros: number): number {
  if (!Number.isFinite(micros) || micros <= 0) return 0;
  return Math.round(micros / COIN_MICROS);
}

/** User debit at settlement: round up to whole coins (platform-favorable). */
export function microsToUserDebitWholeCoins(micros: number): number {
  if (!Number.isFinite(micros) || micros <= 0) return 0;
  return Math.ceil(micros / COIN_MICROS);
}

/** Creator credit at settlement: round down to whole coins (platform-favorable). */
export function microsToCreatorCreditWholeCoins(micros: number): number {
  return microsToWholeCoinsFloor(micros);
}

export function pricePerMinuteToUserMicrosPerSecond(pricePerMinute: number): number {
  return Math.floor((Math.round(pricePerMinute * COIN_MICROS)) / 60);
}

export function pricePerMinuteToCreatorMicrosPerSecond(
  pricePerMinute: number,
  creatorShare: number
): number {
  return Math.floor((Math.round(pricePerMinute * creatorShare * COIN_MICROS)) / 60);
}
