import { Call, ICall } from './call.model';
import { logError, logInfo, logWarning } from '../../utils/logger';
import { recordCallMetric } from '../../utils/monitoring';

export type CallStatus = ICall['status'];

/**
 * High‑level, cross‑system lifecycle stages for a call.
 *
 * This is the **authoritative mapping layer** that ties together:
 * - Backend `Call.status` (business / billing state)
 * - Stream Video call state (media / session state)
 * - Frontend `CallConnectionPhase` (UI orchestration state)
 *
 * The goal is that every place that reasons about "where in the lifecycle is
 * this call?" can use these canonical stages instead of inventing ad‑hoc ones.
 */
export type CallLifecycleStage =
  | 'requested' // user has initiated a call, ringing/offer in progress
  | 'ringing' // callee is being notified, can still be rejected/missed
  | 'accepted' // callee accepted, media is about to connect
  | 'in_session' // participants are connected, billing active
  | 'ended' // cleanly ended
  | 'failed' // explicitly failed (rejected / cancelled / error)
  | 'timeout'; // system‑driven timeout (missed / watchdog / back‑pressure

/**
 * Canonical mapping: backend `Call.status` → lifecycle stage.
 *
 * NOTE: If you add a new `Call.status` value in `call.model.ts`, you MUST:
 *  1. Extend this mapping.
 *  2. Update the frontend mapping comment in `call_connection_controller.dart`.
 */
export const CALL_STATUS_TO_LIFECYCLE_STAGE: Record<CallStatus, CallLifecycleStage> =
  {
    ringing: 'ringing',
    accepted: 'in_session',
    ended: 'ended',
    rejected: 'failed',
    missed: 'timeout',
    cancelled: 'failed',
  };

// Allowed state transitions in the backend Call state machine.
// This is the canonical source of truth for business-level call status.
const ALLOWED_TRANSITIONS: Record<CallStatus, CallStatus[]> = {
  ringing: ['accepted', 'rejected', 'missed', 'cancelled', 'ended'],
  accepted: ['ended', 'cancelled', 'missed'],
  rejected: [], // terminal
  missed: [], // terminal
  cancelled: [], // terminal
  ended: [], // terminal
};

export interface CallStatusTransitionOptions {
  /** Logical source of the transition (e.g. 'video.service', 'webhook.call.ended') */
  source: string;
  /** Optional Stream / webhook event type */
  eventType?: string;
}

/**
 * Lightweight safety check that runs once at module load:
 * verifies that every backend `Call.status` value has an entry in the
 * `CALL_STATUS_TO_LIFECYCLE_STAGE` mapping. If this ever logs a warning,
 * make sure to update the mapping **and** the frontend controller mapping
 * comment (`CallConnectionController`).
 */
(function assertStatusMappingExhaustive() {
  try {
    const schema: any = Call.schema.path('status');
    const enumValues: string[] = Array.isArray(schema?.enumValues)
      ? schema.enumValues
      : [];

    enumValues.forEach((value) => {
      if (!(value in CALL_STATUS_TO_LIFECYCLE_STAGE)) {
        logWarning('CALL_STATUS_MAPPING_MISSING', {
          status: value,
          message:
            'Backend Call.status has no lifecycle mapping. Update CALL_STATUS_TO_LIFECYCLE_STAGE and frontend CallConnectionController mapping.',
        });
      }
    });
  } catch (err) {
    // Best‑effort only; do not crash application if schema inspection fails.
    logError(
      'Failed to validate CALL_STATUS_TO_LIFECYCLE_STAGE mapping',
      err
    );
  }
})();

/**
 * Validate whether a transition from `from` → `to` is allowed.
 * If the current status is unknown (should not happen) we allow the transition but log a warning.
 */
function isAllowedTransition(from: CallStatus, to: CallStatus): boolean {
  const allowed = ALLOWED_TRANSITIONS[from];
  if (!allowed) {
    return true;
  }
  return allowed.includes(to);
}

/**
 * Apply a status transition to a Call document, updating timestamps and emitting
 * structured logs/metrics. This is the single place where backend Call status
 * changes should be made.
 */
export function transitionCallStatus(
  call: ICall,
  nextStatus: CallStatus,
  options: CallStatusTransitionOptions
): void {
  const prevStatus = call.status;

  if (prevStatus === nextStatus) {
    // No-op but still useful to log metrics for idempotent paths.
    recordCallMetric('status_noop', 1, {
      callId: call.callId,
      status: nextStatus,
      source: options.source,
    });
    return;
  }

  if (!isAllowedTransition(prevStatus, nextStatus)) {
    logWarning('Disallowed call status transition', {
      callId: call.callId,
      from: prevStatus,
      to: nextStatus,
      source: options.source,
      eventType: options.eventType,
    });
  }

  // Apply status-specific timestamp semantics.
  switch (nextStatus) {
    case 'ringing':
      // Initial creation — timestamps are set by creators of the Call record.
      break;
    case 'accepted':
      if (!call.acceptedAt) {
        call.acceptedAt = new Date();
      }
      break;
    case 'ended':
      if (!call.endedAt) {
        call.endedAt = new Date();
      }
      if (call.startedAt && call.endedAt) {
        call.durationSeconds = Math.floor(
          (call.endedAt.getTime() - call.startedAt.getTime()) / 1000
        );
      }
      break;
    case 'rejected':
    case 'missed':
    case 'cancelled':
      if (!call.endedAt) {
        call.endedAt = new Date();
      }
      break;
    default:
      break;
  }

  call.status = nextStatus;

  logInfo('CALL_STATUS_CHANGED', {
    callId: call.callId,
    from: prevStatus,
    to: nextStatus,
    source: options.source,
    eventType: options.eventType,
  });

  recordCallMetric('status_changed', 1, {
    callId: call.callId,
    from: prevStatus,
    to: nextStatus,
    source: options.source,
    eventType: options.eventType ?? 'unknown',
  });
}

/**
 * Convenience helper to transition and immediately persist a Call by ID.
 * Intended for simple flows (e.g. admin tools) – existing services should prefer
 * loading the Call once and using `transitionCallStatus` directly.
 */
export async function transitionCallStatusById(
  callId: string,
  nextStatus: CallStatus,
  options: CallStatusTransitionOptions
): Promise<void> {
  const call = await Call.findOne({ callId });
  if (!call) {
    logError('Attempted to transition status for missing Call', new Error('Call not found'), {
      callId,
      to: nextStatus,
      source: options.source,
      eventType: options.eventType,
    });
    return;
  }

  transitionCallStatus(call, nextStatus, options);
  await call.save();
}

