import { logError, logWarning } from '../../utils/logger';
import {
  RazorpayCapturedPayment,
  type RazorpayCapturedObservationSource,
} from './razorpay-captured-payment.model';

export type CapturedPaymentObservation = {
  id: string;
  amount: number;
  currency: string;
  captured: boolean;
  created_at: number;
};

export function normalizeCapturedPaymentObservation(raw: unknown): CapturedPaymentObservation | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  if (
    row.captured !== true ||
    typeof row.id !== 'string' ||
    row.id.length === 0 ||
    !Number.isSafeInteger(row.amount) ||
    (row.amount as number) < 0 ||
    typeof row.currency !== 'string' ||
    row.currency.trim().length !== 3 ||
    !Number.isInteger(row.created_at) ||
    (row.created_at as number) <= 0
  ) {
    return null;
  }
  return {
    id: row.id,
    amount: row.amount as number,
    currency: row.currency.trim().toUpperCase(),
    captured: true,
    created_at: row.created_at as number,
  };
}

export async function upsertCapturedPaymentObservation(
  raw: unknown,
  source: RazorpayCapturedObservationSource,
  observedAt = new Date()
): Promise<boolean> {
  const payment = normalizeCapturedPaymentObservation(raw);
  if (!payment) return false;
  const paymentCreatedAt = new Date(payment.created_at * 1000);
  const providerMode = String(process.env.RAZORPAY_KEY_ID ?? '').startsWith('rzp_test_') ? 'test' : 'live';

  await RazorpayCapturedPayment.updateOne(
    { paymentId: payment.id },
    {
      $set: {
        amountSubunits: payment.amount,
        currency: payment.currency,
        paymentCreatedAt,
        lastObservedAt: observedAt,
      },
      $setOnInsert: {
        paymentId: payment.id,
        providerMode,
        captured: true,
        capturedObservedAt: observedAt,
      },
      $addToSet: { observationSources: source },
    },
    { upsert: true, runValidators: true }
  );
  return true;
}

/**
 * Projection failures must not turn an already verified purchase into a payment failure.
 * Backfill/reconciliation repairs any missed best-effort observation.
 */
export async function observeCapturedPaymentBestEffort(
  raw: unknown,
  source: RazorpayCapturedObservationSource
): Promise<void> {
  try {
    const observed = await upsertCapturedPaymentObservation(raw, source);
    if (!observed) {
      logWarning('razorpay_captured_projection_skipped_invalid_entity', { source });
    }
  } catch (error) {
    logError('razorpay_captured_projection_upsert_failed', error as Error, { source });
  }
}
