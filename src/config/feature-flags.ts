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
   * Switch creator presence to user-like base key model (`creator:availability:*`)
   * with busy derived from active call state.
   */
  creatorPresenceUserModelEnabled:
    process.env.CREATOR_PRESENCE_USER_MODEL_ENABLED === 'true',
  /**
   * Emit parity diagnostics comparing user-model derived state to legacy
   * transition expectations during rollout.
   */
  creatorPresenceUserModelShadowCompareEnabled:
    process.env.CREATOR_PRESENCE_USER_MODEL_SHADOW_COMPARE_ENABLED !== 'false',
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

