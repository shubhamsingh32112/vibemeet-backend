/**
 * Welcome / first-call promo configuration.
 *
 * FREE_CALL_ENABLED — master switch for granting and using the welcome free call.
 * FREE_CALL_DURATION_SECONDS — allowed values: 15, 30, or 45.
 */

export const FREE_CALL_DURATION_OPTIONS = [15, 30, 45] as const;
export type FreeCallDurationSeconds = (typeof FREE_CALL_DURATION_OPTIONS)[number];

const DEFAULT_FREE_CALL_DURATION_SECONDS: FreeCallDurationSeconds = 30;

function parseBooleanEnv(raw: string | undefined, defaultValue: boolean): boolean {
  if (raw === undefined || raw.trim() === '') return defaultValue;
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
  if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  return defaultValue;
}

export function isFreeCallEnabled(): boolean {
  return parseBooleanEnv(process.env.FREE_CALL_ENABLED, true);
}

export function getFreeCallDurationSeconds(): FreeCallDurationSeconds {
  const parsed = Number.parseInt(process.env.FREE_CALL_DURATION_SECONDS || '', 10);
  if (FREE_CALL_DURATION_OPTIONS.includes(parsed as FreeCallDurationSeconds)) {
    return parsed as FreeCallDurationSeconds;
  }
  return DEFAULT_FREE_CALL_DURATION_SECONDS;
}

/** Promo marker granted on eligible signup (seconds of free call allowance). */
export function getWelcomeIntroCallCreditsGrant(): number {
  return isFreeCallEnabled() ? getFreeCallDurationSeconds() : 0;
}

export function validateFreeCallConfig(): void {
  const durationRaw = process.env.FREE_CALL_DURATION_SECONDS;
  if (
    durationRaw !== undefined &&
    durationRaw.trim() !== '' &&
    !FREE_CALL_DURATION_OPTIONS.includes(
      Number.parseInt(durationRaw, 10) as FreeCallDurationSeconds,
    )
  ) {
    throw new Error(
      `FREE_CALL_DURATION_SECONDS must be one of ${FREE_CALL_DURATION_OPTIONS.join(', ')}`,
    );
  }
}
