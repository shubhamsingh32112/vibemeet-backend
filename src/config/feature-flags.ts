export const featureFlags = {
  /**
   * When true, payment flows will use mocked provider behavior instead of
   * talking to the real gateway (e.g. Razorpay). Useful in development.
   */
  mockPaymentProvider: process.env.MOCK_PAYMENT_PROVIDER === 'true',
  /**
   * Enables lag-aware adaptive billing behavior in schedulers.
   */
  billingAdaptiveLagPolicyEnabled: process.env.BILLING_ADAPTIVE_LAG_POLICY_ENABLED !== 'false',
  /**
   * Enables durable v3 billing cursor checkpoints with dual-write/dual-read fallback.
   */
  billingDeltaCursorV3Enabled: process.env.BILLING_DELTA_CURSOR_V3_ENABLED === 'true',
  /**
   * Dual-write billing sequence/lifecycle payload fields while keeping legacy payload compatibility.
   */
  billingSequenceContractEnabled: process.env.BILLING_SEQUENCE_CONTRACT_ENABLED !== 'false',
  /**
   * Presence v2 explicit JSON state in Redis (`creator:presence:*`) with legacy fallback reads.
   */
  presenceV2Enabled: process.env.PRESENCE_V2_ENABLED !== 'false',
  /**
   * Emergency rollback switch: allow legacy creator availability key reads when canonical v2 is missing.
   */
  creatorPresenceLegacyFallbackReadEnabled:
    process.env.CREATOR_PRESENCE_LEGACY_FALLBACK_READ_ENABLED === 'true',
  /**
   * Migration-only compatibility path: dual-write legacy creator:availability key alongside canonical v2.
   */
  creatorPresenceLegacyDualWriteEnabled:
    process.env.CREATOR_PRESENCE_LEGACY_DUAL_WRITE_ENABLED === 'true',
  /**
   * Watchdog that auto-recovers stalled active/settling sessions.
   */
  billingWatchdogEnabled: process.env.BILLING_WATCHDOG_ENABLED !== 'false',
  /**
   * Onboarding strict mode rollout:
   * - log-only: log invalid transitions, allow
   * - soft-enforce: ignore invalid transitions
   * - hard-enforce: reject invalid transitions (HTTP 409)
   */
  onboardingStrictMode: process.env.ONBOARDING_STRICT_MODE ?? 'log-only',
  /** ISO date; after this, rollout fast-forward (welcome/bonus→completed) is disabled. */
  onboardingFastForwardUntil: process.env.ONBOARDING_FAST_FORWARD_UNTIL ?? '',
  /** First mobile semver that sends strict v2 onboarding (legacy clients below may use rollout fast-forward). */
  onboardingMinFixedClientVersion: process.env.MIN_FIXED_CLIENT_VERSION ?? '',
};

