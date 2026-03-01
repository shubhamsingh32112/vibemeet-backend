/**
 * Pricing Configuration
 * 
 * 🔥 FIX 12: Centralized pricing configuration
 * All pricing values are now configurable via environment variables
 * with sensible defaults.
 * 
 * Benefits:
 * - Change pricing without code deploy
 * - A/B test pricing strategies
 * - Dynamic pricing per creator (future)
 * - Easy to audit and adjust
 */

/**
 * Creator earnings per second (as decimal)
 * Default: 0.3 coins/second (18 coins/minute)
 * 
 * Environment variable: CREATOR_EARNINGS_PER_SECOND
 */
export const CREATOR_EARNINGS_PER_SECOND: number = parseFloat(
  process.env.CREATOR_EARNINGS_PER_SECOND || '0.3'
);

/**
 * Creator share percentage (as decimal)
 * Default: 0.30 (30%)
 * 
 * Environment variable: CREATOR_SHARE_PERCENTAGE
 */
export const CREATOR_SHARE_PERCENTAGE: number = parseFloat(
  process.env.CREATOR_SHARE_PERCENTAGE || '0.30'
);

/**
 * User cost per second (as decimal)
 * Default: 1.0 coins/second
 * 
 * Note: This is typically derived from creator's price per minute
 * Environment variable: USER_COST_PER_SECOND (optional, usually calculated)
 */
export const USER_COST_PER_SECOND: number = parseFloat(
  process.env.USER_COST_PER_SECOND || '1.0'
);

/**
 * Minimum coins required to start a call
 * Default: 10 coins
 * 
 * Environment variable: MIN_COINS_TO_CALL
 */
export const MIN_COINS_TO_CALL: number = parseInt(
  process.env.MIN_COINS_TO_CALL || '10',
  10
);

/**
 * Maximum call duration in seconds (hard cap)
 * Default: 3600 seconds (1 hour)
 * 
 * Environment variable: MAX_CALL_DURATION_SECONDS
 */
export const MAX_CALL_DURATION_SECONDS: number = parseInt(
  process.env.MAX_CALL_DURATION_SECONDS || '3600',
  10
);

/**
 * Default per-creator call duration limit in seconds
 * Default: 1800 seconds (30 minutes)
 * Can be overridden per creator in database
 * 
 * Environment variable: DEFAULT_CREATOR_CALL_DURATION_SECONDS
 */
export const DEFAULT_CREATOR_CALL_DURATION_SECONDS: number = parseInt(
  process.env.DEFAULT_CREATOR_CALL_DURATION_SECONDS || '1800',
  10
);

/**
 * Default per-user call duration limit in seconds
 * Default: 3600 seconds (1 hour)
 * Can be overridden per user in database
 * 
 * Environment variable: DEFAULT_USER_CALL_DURATION_SECONDS
 */
export const DEFAULT_USER_CALL_DURATION_SECONDS: number = parseInt(
  process.env.DEFAULT_USER_CALL_DURATION_SECONDS || '3600',
  10
);

/**
 * Warning threshold before call duration limit (seconds)
 * Default: 300 seconds (5 minutes before limit)
 * 
 * Environment variable: CALL_DURATION_WARNING_SECONDS
 */
export const CALL_DURATION_WARNING_SECONDS: number = parseInt(
  process.env.CALL_DURATION_WARNING_SECONDS || '300',
  10
);

/**
 * Validate pricing configuration on startup
 */
export function validatePricingConfig(): void {
  if (CREATOR_EARNINGS_PER_SECOND < 0 || CREATOR_EARNINGS_PER_SECOND > 100) {
    throw new Error('CREATOR_EARNINGS_PER_SECOND must be between 0 and 100');
  }
  
  if (CREATOR_SHARE_PERCENTAGE < 0 || CREATOR_SHARE_PERCENTAGE > 1) {
    throw new Error('CREATOR_SHARE_PERCENTAGE must be between 0 and 1');
  }
  
  if (MIN_COINS_TO_CALL < 0) {
    throw new Error('MIN_COINS_TO_CALL must be >= 0');
  }
  
  if (MAX_CALL_DURATION_SECONDS < 60) {
    throw new Error('MAX_CALL_DURATION_SECONDS must be >= 60');
  }
  
  if (DEFAULT_CREATOR_CALL_DURATION_SECONDS < 60) {
    throw new Error('DEFAULT_CREATOR_CALL_DURATION_SECONDS must be >= 60');
  }
  
  if (DEFAULT_USER_CALL_DURATION_SECONDS < 60) {
    throw new Error('DEFAULT_USER_CALL_DURATION_SECONDS must be >= 60');
  }
  
  if (CALL_DURATION_WARNING_SECONDS < 0) {
    throw new Error('CALL_DURATION_WARNING_SECONDS must be >= 0');
  }
  
  // Log pricing configuration (only in development or if LOG_CONFIG is enabled)
  if (process.env.NODE_ENV === 'development' || process.env.LOG_CONFIG === 'true') {
    // Dynamic import to avoid circular dependencies
    import('../utils/logger').then(({ logInfo }) => {
      logInfo('Pricing configuration validated', {
        creatorEarningsPerSecond: CREATOR_EARNINGS_PER_SECOND,
        creatorSharePercentage: (CREATOR_SHARE_PERCENTAGE * 100).toFixed(1) + '%',
        minCoinsToCall: MIN_COINS_TO_CALL,
        maxCallDurationSeconds: MAX_CALL_DURATION_SECONDS,
        defaultCreatorLimit: DEFAULT_CREATOR_CALL_DURATION_SECONDS,
        defaultUserLimit: DEFAULT_USER_CALL_DURATION_SECONDS,
        durationWarningSeconds: CALL_DURATION_WARNING_SECONDS,
      });
    }).catch(() => {
      // Ignore if logger not available (shouldn't happen)
    });
  }
}
