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
