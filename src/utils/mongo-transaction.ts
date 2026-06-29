/**
 * Helpers for manual MongoDB multi-document transaction retry (billing settlement).
 */

export type SettlementFailureStage = 'before_write' | 'during_write' | 'commit';

export type SettlementWriteStage =
  | 'read_user'
  | 'debit_user_wallet'
  | 'upsert_user_debit_txn'
  | 'consume_intro_promo'
  | 'credit_creator_wallet'
  | 'upsert_creator_credit_txn'
  | 'staff_revenue_split'
  | 'upsert_call_history'
  | 'update_call_settlement'
  | 'commit';

const WRITE_STAGES: ReadonlySet<string> = new Set([
  'debit_user_wallet',
  'upsert_user_debit_txn',
  'consume_intro_promo',
  'credit_creator_wallet',
  'upsert_creator_credit_txn',
  'staff_revenue_split',
  'upsert_call_history',
  'update_call_settlement',
]);

function mongoErrRecord(err: unknown): Record<string, unknown> {
  if (err && typeof err === 'object') {
    return err as Record<string, unknown>;
  }
  return {};
}

export function getMongoErrorLabels(err: unknown): string[] {
  const rec = mongoErrRecord(err);
  const labels = rec.errorLabels;
  if (Array.isArray(labels)) {
    return labels.map(String);
  }
  return [];
}

export function getMongoErrorCode(err: unknown): number | undefined {
  const rec = mongoErrRecord(err);
  const code = rec.code;
  return typeof code === 'number' ? code : undefined;
}

export function getMongoErrorName(err: unknown): string | undefined {
  const rec = mongoErrRecord(err);
  const name = rec.name;
  return typeof name === 'string' ? name : undefined;
}

export function isUnknownCommitResult(err: unknown): boolean {
  return getMongoErrorLabels(err).includes('UnknownTransactionCommitResult');
}

export function isTransientMongoTransactionError(err: unknown): boolean {
  const labels = getMongoErrorLabels(err);
  if (labels.includes('TransientTransactionError')) {
    return true;
  }
  if (labels.includes('UnknownTransactionCommitResult')) {
    return true;
  }
  const code = getMongoErrorCode(err);
  if (code === 112) {
    return true;
  }
  const name = getMongoErrorName(err);
  if (name === 'MongoServerError' || name === 'MongoError') {
    const msg = String(mongoErrRecord(err).message || '');
    if (/Please retry your operation or multi-document transaction/i.test(msg)) {
      return true;
    }
    if (/WriteConflict/i.test(msg)) {
      return true;
    }
  }
  return false;
}

export function classifyFailureStage(
  err: unknown,
  lastWriteStage: string
): SettlementFailureStage {
  if (lastWriteStage === 'commit' || isUnknownCommitResult(err)) {
    return 'commit';
  }
  if (lastWriteStage === 'read_user' || !WRITE_STAGES.has(lastWriteStage)) {
    return 'before_write';
  }
  return 'during_write';
}

export function inferConflictingCollection(
  writeStage: string,
  err: unknown
): string | undefined {
  const stageMap: Record<string, string> = {
    read_user: 'users',
    debit_user_wallet: 'users',
    upsert_user_debit_txn: 'cointransactions',
    consume_intro_promo: 'users',
    credit_creator_wallet: 'users',
    upsert_creator_credit_txn: 'cointransactions',
    staff_revenue_split: 'staffwalletledgers',
    upsert_call_history: 'callhistories',
    update_call_settlement: 'calls',
    commit: 'transaction',
  };
  const fromStage = stageMap[writeStage];
  const msg = String(mongoErrRecord(err).message || '');
  const dupMatch = msg.match(/collection:\s*(\S+)/i);
  if (dupMatch) {
    return dupMatch[1];
  }
  if (/E11000/i.test(msg)) {
    if (/cointransaction/i.test(msg)) return 'cointransactions';
    if (/callhistor/i.test(msg)) return 'callhistories';
  }
  return fromStage;
}

export function settlementTxnBackoffMs(attempt: number): number {
  const base = [50, 150, 400][Math.min(attempt, 2)] ?? 400;
  const jitter = Math.floor(Math.random() * 50);
  return base + jitter;
}

export function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
