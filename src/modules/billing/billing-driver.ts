/**
 * Billing driver selection — isolated from billing.queue to avoid circular imports
 * (e.g. billing-termination.queue → driver must not load billing.service).
 */
export function isBullmqBillingEnabled(): boolean {
  return true;
}
