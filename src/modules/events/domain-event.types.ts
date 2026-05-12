/**
 * Internal domain events (Mongo-backed outbox). No external broker in phase 2.
 */

export type DomainEventStatus = 'pending' | 'processed' | 'failed' | 'dead';

export type BaseDomainEventPayload = {
  idempotencyKey: string;
  occurredAt: string;
  aggregateType: string;
  aggregateId: string;
  metadata?: Record<string, unknown>;
};

export type CallEndedPayload = BaseDomainEventPayload & {
  eventKind: 'CallEnded';
  callId: string;
};

export type SettlementCompletedPayload = BaseDomainEventPayload & {
  eventKind: 'SettlementCompleted';
  callId: string;
  totalEarnedCreator: number;
  durationSeconds: number;
};

export type StaffLedgerCreditedPayload = BaseDomainEventPayload & {
  eventKind: 'StaffLedgerCredited';
  callId: string;
  staffUserId: string;
  direction: 'credit' | 'debit';
  amountCoins: number;
  sourceLedgerKey: string;
};

export type WithdrawalRequestedPayload = BaseDomainEventPayload & {
  eventKind: 'WithdrawalRequested';
  withdrawalId: string;
  staffUserId?: string;
  creatorUserId?: string;
  amount: number;
};

export type WithdrawalCompletedPayload = BaseDomainEventPayload & {
  eventKind: 'WithdrawalCompleted';
  withdrawalId: string;
  status: string;
};

export type DomainEventPayload =
  | CallEndedPayload
  | SettlementCompletedPayload
  | StaffLedgerCreditedPayload
  | WithdrawalRequestedPayload
  | WithdrawalCompletedPayload;
