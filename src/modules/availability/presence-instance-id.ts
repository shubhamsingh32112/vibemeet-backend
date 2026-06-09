import { getBillingInstanceId, billingInstanceIdsMatch } from '../billing/billing-instance-id';

/** Canonical presence runtime instance id (PRESENCE_INSTANCE_ID or billing instance id). */
export function getPresenceInstanceId(): string {
  const configured = process.env.PRESENCE_INSTANCE_ID?.trim();
  if (configured) return configured;
  return getBillingInstanceId();
}

export { billingInstanceIdsMatch as presenceInstanceIdsMatch };
