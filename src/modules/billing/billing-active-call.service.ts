import { Redis } from 'ioredis';
import { resolveBillingRuntimeState } from './billing-runtime-resolver.service';
import { BillingLifecycleState } from './billing-lifecycle.machine';

interface ActiveCallCheckParams {
  callId: string;
  userFirebaseUid?: string;
  creatorFirebaseUid?: string;
}

export async function isCallActive(
  _redis: Redis,
  params: ActiveCallCheckParams
): Promise<boolean> {
  const { callId, userFirebaseUid, creatorFirebaseUid } = params;
  const runtime = await resolveBillingRuntimeState(callId);
  if (!runtime.session) {
    return false;
  }

  const lifecycle = String(runtime.session.lifecycleState || 'ACTIVE') as BillingLifecycleState;
  const terminal = lifecycle === 'SETTLED' || lifecycle === 'FAILED';
  if (terminal) {
    return false;
  }

  if (userFirebaseUid && runtime.session.userFirebaseUid !== userFirebaseUid) {
    return false;
  }
  if (creatorFirebaseUid && runtime.session.creatorFirebaseUid !== creatorFirebaseUid) {
    return false;
  }
  return true;
}

/** True when the call session exists, is non-terminal, and the UID is payer or creator. */
export async function isCallActiveForParticipant(
  _redis: Redis,
  params: { callId: string; participantFirebaseUid: string }
): Promise<boolean> {
  const runtime = await resolveBillingRuntimeState(params.callId);
  if (!runtime.session) {
    return false;
  }
  const { userFirebaseUid, creatorFirebaseUid } = runtime.session;
  if (
    params.participantFirebaseUid !== userFirebaseUid &&
    params.participantFirebaseUid !== creatorFirebaseUid
  ) {
    return false;
  }
  const lifecycle = String(runtime.session.lifecycleState || 'ACTIVE') as BillingLifecycleState;
  return lifecycle !== 'SETTLED' && lifecycle !== 'FAILED';
}

export function isNonTerminalLifecycle(
  lifecycleState: string | undefined
): boolean {
  const lifecycle = String(lifecycleState || 'ACTIVE') as BillingLifecycleState;
  return lifecycle !== 'SETTLED' && lifecycle !== 'FAILED';
}
