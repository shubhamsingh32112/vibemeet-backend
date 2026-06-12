import {
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

type RecoveryGateState = {
  inFlight: boolean;
  lastRecoveryAtMs: number;
};

export type RecoveryGateAcquireResult = 'ok' | 'in_flight' | 'debounce';

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
    };
  } catch {
    return { inFlight: false, lastRecoveryAtMs: 0 };
  }
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
  if (now - gate.lastRecoveryAtMs < debounceMs) {
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
