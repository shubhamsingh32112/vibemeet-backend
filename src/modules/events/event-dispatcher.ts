import { getHandlersForType } from './event-bus';
import type { DomainEventPayload } from './domain-event.types';
import { logDebug, logWarning } from '../../utils/logger';

export async function dispatchDomainEventPayload(
  eventType: string,
  payload: Record<string, unknown>
): Promise<void> {
  const handlers = getHandlersForType(eventType);
  if (handlers.length === 0) {
    logDebug('Domain event dispatched with no handlers (no-op)', { eventType });
    return;
  }
  const typed = payload as unknown as DomainEventPayload;
  for (const h of handlers) {
    try {
      await h(typed);
    } catch (e) {
      logWarning('Domain event handler failed', {
        eventType,
        error: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  }
}
