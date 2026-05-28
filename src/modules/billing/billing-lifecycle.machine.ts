import { logWarning } from '../../utils/logger';
import { recordBillingMetric } from '../../utils/monitoring';
import { BillingLifecycleTransition } from './billing-lifecycle-transition.model';

export type BillingLifecycleState =
  | 'INIT'
  | 'STARTING'
  | 'ACTIVE'
  | 'ENDING'
  | 'SETTLING'
  | 'SETTLED'
  | 'FAILED'
  | 'RECOVERING'
  | 'FAILED_RECOVERY_SETTLEMENT';

type TransitionRequest = {
  callId: string;
  from: BillingLifecycleState;
  to: BillingLifecycleState;
  source: string;
  reason: string;
};

type TransitionResult = {
  next: BillingLifecycleState;
  changed: boolean;
  valid: boolean;
};

const ALLOWED_TRANSITIONS: Record<BillingLifecycleState, ReadonlySet<BillingLifecycleState>> = {
  INIT: new Set<BillingLifecycleState>(['STARTING', 'ACTIVE', 'FAILED']),
  STARTING: new Set<BillingLifecycleState>(['ACTIVE', 'ENDING', 'FAILED', 'RECOVERING']),
  ACTIVE: new Set<BillingLifecycleState>([
    'ENDING',
    'RECOVERING',
    'SETTLING',
    'FAILED',
    'FAILED_RECOVERY_SETTLEMENT',
  ]),
  RECOVERING: new Set<BillingLifecycleState>([
    'ACTIVE',
    'ENDING',
    'SETTLING',
    'FAILED',
    'FAILED_RECOVERY_SETTLEMENT',
  ]),
  ENDING: new Set<BillingLifecycleState>(['SETTLING', 'SETTLED', 'FAILED', 'FAILED_RECOVERY_SETTLEMENT']),
  SETTLING: new Set<BillingLifecycleState>(['SETTLED', 'FAILED', 'FAILED_RECOVERY_SETTLEMENT']),
  SETTLED: new Set<BillingLifecycleState>([]),
  FAILED: new Set<BillingLifecycleState>(['SETTLING', 'FAILED_RECOVERY_SETTLEMENT']),
  FAILED_RECOVERY_SETTLEMENT: new Set<BillingLifecycleState>([]),
};

export function transitionBillingState(req: TransitionRequest): TransitionResult {
  if (req.from === req.to) {
    return { next: req.from, changed: false, valid: true };
  }

  const allowedTargets = ALLOWED_TRANSITIONS[req.from];
  if (allowedTargets.has(req.to)) {
    recordBillingMetric('billing_lifecycle_transition', 1, {
      callId: req.callId,
      from: req.from,
      to: req.to,
      source: req.source,
      reason: req.reason,
    });
    return { next: req.to, changed: true, valid: true };
  }

  logWarning('Invalid billing lifecycle transition rejected', {
    callId: req.callId,
    from: req.from,
    to: req.to,
    source: req.source,
    reason: req.reason,
  });
  recordBillingMetric('billing_lifecycle_invalid_transition', 1, {
    callId: req.callId,
    from: req.from,
    to: req.to,
    source: req.source,
    reason: req.reason,
  });
  return { next: req.from, changed: false, valid: false };
}

export async function transitionBillingStateWithAudit(
  req: TransitionRequest
): Promise<TransitionResult> {
  const transitioned = transitionBillingState(req);
  const changed = transitioned.changed && transitioned.valid;
  if (!changed) {
    return transitioned;
  }

  const transitionId = `${req.callId}:${Date.now()}:${req.from}->${transitioned.next}`;
  try {
    await BillingLifecycleTransition.create({
      transitionId,
      callId: req.callId,
      previousState: req.from,
      nextState: transitioned.next,
      reason: req.reason,
      source: req.source,
      timestamp: new Date(),
    });
  } catch (error) {
    logWarning('Failed to persist billing lifecycle transition audit', {
      callId: req.callId,
      from: req.from,
      to: transitioned.next,
      source: req.source,
      reason: req.reason,
      error: error instanceof Error ? error.message : String(error),
    });
    recordBillingMetric('billing_lifecycle_transition_audit_failed', 1, {
      callId: req.callId,
      from: req.from,
      to: transitioned.next,
      source: req.source,
      reason: req.reason,
    });
  }
  return transitioned;
}

