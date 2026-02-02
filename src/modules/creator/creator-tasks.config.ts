/**
 * Creator Task Definitions
 * 
 * ⚠️ These values must match UI exactly (no magic numbers in frontend).
 * 
 * Tasks are based on total completed video call minutes.
 * Only ended calls with duration > 0 count towards minutes.
 * 
 * C) RESET SEMANTICS (Future):
 * 
 * The current implementation is "lifetime" tasks (never reset).
 * To add reset semantics later, you can:
 * 
 * 1. Monthly Reset:
 *    - Add `resetPeriod: 'monthly'` to task config
 *    - Add `resetAt: Date` field to CreatorTaskProgress
 *    - Cron job: Delete/reset progress records at month boundary
 *    - Query: Filter by reset period when calculating progress
 * 
 * 2. Seasonal Campaigns:
 *    - Add `campaignId: string` to task config
 *    - Add `campaignStart: Date, campaignEnd: Date`
 *    - Filter tasks by active campaign
 *    - Auto-reset when campaign ends
 * 
 * 3. Lifetime (Current):
 *    - No reset - tasks accumulate forever
 *    - Perfect for milestone rewards
 * 
 * Implementation note: Since tasks are stateless (computed from calls),
 * resetting is just a matter of:
 * - Deleting/resetting CreatorTaskProgress records
 * - Optionally filtering calls by date range
 * - No code rewrite needed - just config + cron job
 */
export interface CreatorTaskDefinition {
  key: string;
  thresholdMinutes: number;
  rewardCoins: number;
  // Future: resetPeriod?: 'lifetime' | 'monthly' | 'seasonal';
  // Future: campaignId?: string;
  // Future: campaignStart?: Date;
  // Future: campaignEnd?: Date;
}

export const CREATOR_TASKS: CreatorTaskDefinition[] = [
  { key: 'minutes_200', thresholdMinutes: 200, rewardCoins: 100 },
  { key: 'minutes_350', thresholdMinutes: 350, rewardCoins: 150 },
  { key: 'minutes_480', thresholdMinutes: 480, rewardCoins: 300 },
  { key: 'minutes_600', thresholdMinutes: 600, rewardCoins: 300 },
];

/**
 * Get task definition by key
 */
export const getTaskByKey = (key: string): CreatorTaskDefinition | undefined => {
  return CREATOR_TASKS.find((task) => task.key === key);
};

/**
 * Validate task key exists
 */
export const isValidTaskKey = (key: string): boolean => {
  return CREATOR_TASKS.some((task) => task.key === key);
};
