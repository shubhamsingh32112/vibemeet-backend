/**
 * Lightweight env-based thresholds for fraud rules (no DB singleton in phase 2).
 */
export function getFraudThresholds() {
  return {
    maxReferralsPerBdPerDay: parseInt(process.env.FRAUD_MAX_REFERRALS_PER_BD_DAY ?? '200', 10) || 200,
    maxStaffWithdrawalsPerWeek: parseInt(process.env.FRAUD_MAX_STAFF_WITHDRAWALS_PER_WEEK ?? '30', 10) || 30,
    creatorEarningSpikeMultiplier: parseFloat(process.env.FRAUD_EARNING_SPIKE_MULTIPLIER ?? '10') || 10,
  };
}
