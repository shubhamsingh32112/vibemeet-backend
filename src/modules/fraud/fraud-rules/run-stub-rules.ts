import mongoose from 'mongoose';
import { FraudSignal } from '../fraud-signal.model';
import { User } from '../../user/user.model';
import { getFraudThresholds } from '../fraud-thresholds';

/**
 * Placeholder batch evaluation — extend with real aggregations per rule.
 * Idempotent upsert via idempotencyKey per subject+rule+window bucket.
 */
export async function runStubFraudRulesScan(): Promise<{ created: number }> {
  let created = 0;
  const thresholds = getFraudThresholds();

  if (process.env.FRAUD_STUB_RULES_ENABLED !== 'true') {
    return { created: 0 };
  }

  const suspiciousVelocity = await User.countDocuments({
    role: { $in: ['agency', 'bd'] },
    createdAt: { $gte: new Date(Date.now() - 86400000) },
  });

  if (suspiciousVelocity > thresholds.maxReferralsPerBdPerDay) {
    const key = `stub_velocity_${new Date().toISOString().slice(0, 10)}`;
    try {
      await FraudSignal.create({
        ruleId: 'excessive_bd_accounts_daily',
        severity: 'low',
        reason: 'High count of BD-role users created in 24h (stub threshold)',
        metadata: { count: suspiciousVelocity, threshold: thresholds.maxReferralsPerBdPerDay },
        status: 'open',
        idempotencyKey: key,
      });
      created++;
    } catch {
      /* duplicate idempotency */
    }
  }

  return { created };
}

export async function detectSelfReferralStub(userId: string): Promise<boolean> {
  if (!mongoose.Types.ObjectId.isValid(userId)) return false;
  const u = await User.findById(userId).select('referredBy _id').lean();
  if (!u?.referredBy) return false;
  return u.referredBy.toString() === userId;
}
