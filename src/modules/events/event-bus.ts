import type { DomainEventPayload } from './domain-event.types';

export type DomainEventHandler = (payload: DomainEventPayload) => Promise<void>;

const handlers = new Map<string, DomainEventHandler[]>();

export function subscribeDomainEvent(eventType: string, handler: DomainEventHandler): void {
  const list = handlers.get(eventType) ?? [];
  list.push(handler);
  handlers.set(eventType, list);
}

export function getHandlersForType(eventType: string): DomainEventHandler[] {
  return handlers.get(eventType) ?? [];
}
