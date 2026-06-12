import { subscribeDomainEvent } from './event-bus';
import type { DomainEventPayload } from './domain-event.types';
import {
  projectCallHistoryFromBillingEvent,
  type CallBillingProjectionEvent,
} from '../billing/call-history-projector.service';

function billingProjectionHandler(type: CallBillingProjectionEvent['type']) {
  return async (payload: DomainEventPayload): Promise<void> => {
    const raw = payload as unknown as Record<string, unknown>;
    const callId = String(raw.callId || raw.aggregateId || '').trim();
    if (!callId) return;
    await projectCallHistoryFromBillingEvent({
      type,
      callId,
      payload: raw,
    });
  };
}

subscribeDomainEvent('call.billing.ending', billingProjectionHandler('call.billing.ending'));
subscribeDomainEvent('call.billing.settled', billingProjectionHandler('call.billing.settled'));
subscribeDomainEvent(
  'call.billing.failed_settlement',
  billingProjectionHandler('call.billing.failed_settlement')
);
