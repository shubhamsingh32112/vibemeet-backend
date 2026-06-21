import {
  billingRecoveryEmptyCacheKey,
  billingRecoveryGateInflightKey,
  billingRecoveryGateKey,
  getRedis,
} from '../../config/redis';

const RECOVERY_GATE_TTL_SECONDS = Math.min(
  300,
  Math.max(30, parseInt(process.env.BILLING_RECOVERY_GATE_TTL_SECONDS || '120', 10) || 120)
);
const RECOVERY_INFLIGHT_TTL_SECONDS = Math.min(
  60,
  Math.max(10, parseInt(process.env.BILLING_RECOVERY_INFLIGHT_TTL_SECONDS || '30', 10) || 30)
);
const RECOVERY_EMPTY_CACHE_TTL_SECONDS = Math.min(
  10,
  Math.max(1, parseInt(process.env.BILLING_RECOVERY_EMPTY_CACHE_TTL_SECONDS || '3', 10) || 3)
);

type RecoveryGateState = {
  inFlight: boolean;
  lastRecoveryAtMs: number;
  lastEmptyAtMs?: number;
};

export type RecoveryGateAcquireResult = 'ok' | 'in_flight' | 'debounce';

export function getRecoveryEmptyDebounceMs(): number {
  return Math.min(
    5000,
    Math.max(500, parseInt(process.env.BILLING_RECOVERY_EMPTY_DEBOUNCE_MS || '2000', 10) || 2000)
  );
}

async function readGate(firebaseUid: string): Promise<RecoveryGateState> {
  const raw = await getRedis().get(billingRecoveryGateKey(firebaseUid));
  if (!raw) {
    return { inFlight: false, lastRecoveryAtMs: 0 };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<RecoveryGateState>;
    return {
      inFlight: Boolean(parsed.inFlight),
      lastRecoveryAtMs: Math.max(0, Number(parsed.lastRecoveryAtMs) || 0),
      lastEmptyAtMs: Math.max(0, Number(parsed.lastEmptyAtMs) || 0) || undefined,
    };
  } catch {
    return { inFlight: false, lastRecoveryAtMs: 0 };
  }
}

function effectiveDebounceMs(gate: RecoveryGateState, debounceMs: number, now: number): number {
  const emptyDebounceMs = getRecoveryEmptyDebounceMs();
  if (gate.lastEmptyAtMs && now - gate.lastEmptyAtMs < emptyDebounceMs) {
    return emptyDebounceMs;
  }
  return debounceMs;
}

export async function isRecoveryEmptyCached(firebaseUid: string): Promise<boolean> {
  return (await getRedis().exists(billingRecoveryEmptyCacheKey(firebaseUid))) === 1;
}

export async function markRecoveryEmptyOutcome(firebaseUid: string): Promise<void> {
  const redis = getRedis();
  const now = Date.now();
  await redis
    .setex(billingRecoveryEmptyCacheKey(firebaseUid), RECOVERY_EMPTY_CACHE_TTL_SECONDS, '1')
    .catch(() => 0);
  const gate = await readGate(firebaseUid);
  gate.inFlight = false;
  gate.lastEmptyAtMs = now;
  gate.lastRecoveryAtMs = now;
  await redis.setex(
    billingRecoveryGateKey(firebaseUid),
    RECOVERY_GATE_TTL_SECONDS,
    JSON.stringify(gate)
  );
  await redis.del(billingRecoveryGateInflightKey(firebaseUid)).catch(() => 0);
}

export async function tryAcquireRecoveryGate(
  firebaseUid: string,
  debounceMs: number
): Promise<RecoveryGateAcquireResult> {
  const redis = getRedis();
  const gate = await readGate(firebaseUid);
  const now = Date.now();

  if (gate.inFlight) {
    return 'in_flight';
  }
  const debounce = effectiveDebounceMs(gate, debounceMs, now);
  if (now - gate.lastRecoveryAtMs < debounce) {
    return 'debounce';
  }

  const inflightAcquired = await redis.set(
    billingRecoveryGateInflightKey(firebaseUid),
    String(now),
    'EX',
    RECOVERY_INFLIGHT_TTL_SECONDS,
    'NX'
  );
  if (inflightAcquired !== 'OK') {
    return 'in_flight';
  }

  const next: RecoveryGateState = { inFlight: true, lastRecoveryAtMs: now };
  if (gate.lastEmptyAtMs) {
    next.lastEmptyAtMs = gate.lastEmptyAtMs;
  }
  await redis.setex(
    billingRecoveryGateKey(firebaseUid),
    RECOVERY_GATE_TTL_SECONDS,
    JSON.stringify(next)
  );
  return 'ok';
}

export async function releaseRecoveryGate(firebaseUid: string): Promise<void> {
  const redis = getRedis();
  const gate = await readGate(firebaseUid);
  gate.inFlight = false;
  await redis.setex(
    billingRecoveryGateKey(firebaseUid),
    RECOVERY_GATE_TTL_SECONDS,
    JSON.stringify(gate)
  );
  await redis.del(billingRecoveryGateInflightKey(firebaseUid)).catch(() => 0);
}
