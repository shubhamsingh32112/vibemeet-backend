import { randomUUID } from 'crypto';
import mongoose from 'mongoose';
import { DomainEvent } from './domain-event.model';
import { dispatchDomainEventPayload } from './event-dispatcher';
import { logError } from '../../utils/logger';
import { StaffWalletLedger } from '../billing/staff-wallet-ledger.model';

const MAX_RETRIES = parseInt(process.env.DOMAIN_EVENT_MAX_RETRIES ?? '8', 10) || 8;

function isDomainEventsEnabled(): boolean {
  return process.env.DOMAIN_EVENTS_ENABLED === 'true';
}

export async function persistDomainEvent(params: {
  eventType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
}): Promise<void> {
  if (!isDomainEventsEnabled()) return;
  try {
    await DomainEvent.create({
      eventId: randomUUID(),
      eventType: params.eventType,
      aggregateId: params.aggregateId,
      payload: params.payload,
      status: 'pending',
      retryCount: 0,
      idempotencyKey: params.idempotencyKey,
    });
  } catch (e: unknown) {
    if (mongoose.connection.readyState === 1 && (e as { code?: number }).code === 11000) {
      return;
    }
    logError('persistDomainEvent failed', e instanceof Error ? e : new Error(String(e)), {
      eventType: params.eventType,
    });
  }
}

/**
 * After settlement commits: record SettlementCompleted + StaffLedgerCredited outbox rows.
 */
export async function enqueueSettlementDomainEvents(params: {
  callId: string;
  totalEarnedCreator: number;
  durationSeconds: number;
}): Promise<void> {
  if (!isDomainEventsEnabled()) return;
  const { callId, totalEarnedCreator, durationSeconds } = params;
  const now = new Date().toISOString();

  await persistDomainEvent({
    eventType: 'SettlementCompletedEvent',
    aggregateId: callId,
    idempotencyKey: `domain_evt_settlement_completed_${callId}`,
    payload: {
      eventKind: 'SettlementCompleted',
      idempotencyKey: `domain_evt_settlement_completed_${callId}`,
      occurredAt: now,
      aggregateType: 'call',
      aggregateId: callId,
      callId,
      totalEarnedCreator,
      durationSeconds,
    },
  });

  const rows = await StaffWalletLedger.find({ callId })
    .select('staffUserId direction amountCoins idempotencyKey')
    .lean();

  for (const row of rows) {
    const key = row.idempotencyKey || `${callId}_${String(row.staffUserId)}_${row.direction}`;
    await persistDomainEvent({
      eventType: 'StaffLedgerCreditedEvent',
      aggregateId: callId,
      idempotencyKey: `domain_evt_${key}`,
      payload: {
        eventKind: 'StaffLedgerCredited',
        idempotencyKey: `domain_evt_${key}`,
        occurredAt: now,
        aggregateType: 'call',
        aggregateId: callId,
        callId,
        staffUserId: String(row.staffUserId),
        direction: row.direction,
        amountCoins: row.amountCoins,
        sourceLedgerKey: key,
      },
    });
  }
}

export async function processPendingDomainEvents(limit = 50): Promise<number> {
  if (!isDomainEventsEnabled()) return 0;
  const batch = await DomainEvent.find({ status: 'pending' })
    .sort({ createdAt: 1 })
    .limit(limit)
    .lean();

  let ok = 0;
  for (const doc of batch) {
    try {
      await dispatchDomainEventPayload(doc.eventType, doc.payload as Record<string, unknown>);
      await DomainEvent.updateOne(
        { _id: doc._id },
        { $set: { status: 'processed', processedAt: new Date(), lastError: undefined } }
      );
      ok++;
    } catch (e) {
      const next = (doc.retryCount ?? 0) + 1;
      const dead = next >= MAX_RETRIES;
      await DomainEvent.updateOne(
        { _id: doc._id },
        {
          $set: {
            status: dead ? 'dead' : 'failed',
            retryCount: next,
            lastError: e instanceof Error ? e.message.slice(0, 2000) : String(e),
          },
        }
      );
    }
  }
  return ok;
}

export async function replayDomainEvent(eventId: string): Promise<boolean> {
  const doc = await DomainEvent.findOne({ eventId }).lean();
  if (!doc) return false;
  await DomainEvent.updateOne(
    { eventId },
    { $set: { status: 'pending', retryCount: 0 }, $unset: { processedAt: 1, lastError: 1 } }
  );
  return true;
}

export async function getDomainEventStats(): Promise<{
  pending: number;
  failed: number;
  dead: number;
  processed1h: number;
}> {
  const oneHourAgo = new Date(Date.now() - 3600_000);
  const [pending, failed, dead, processed1h] = await Promise.all([
    DomainEvent.countDocuments({ status: 'pending' }),
    DomainEvent.countDocuments({ status: 'failed' }),
    DomainEvent.countDocuments({ status: 'dead' }),
    DomainEvent.countDocuments({ status: 'processed', processedAt: { $gte: oneHourAgo } }),
  ]);
  return { pending, failed, dead, processed1h };
}
