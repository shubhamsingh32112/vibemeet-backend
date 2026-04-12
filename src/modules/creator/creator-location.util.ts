/** Display location (e.g. city / region); optional on creator profiles. */
export const CREATOR_LOCATION_MAX_LEN = 120;

export type ParsedCreatorLocation =
  | { kind: 'omit' }
  | { kind: 'clear' }
  | { kind: 'set'; value: string };

/** PATCH/update: undefined = leave unchanged, null or "" = clear. */
export function parseCreatorLocationForUpdate(raw: unknown): ParsedCreatorLocation | { kind: 'error'; message: string } {
  if (raw === undefined) return { kind: 'omit' };
  if (raw === null || raw === '') return { kind: 'clear' };
  if (typeof raw !== 'string') return { kind: 'error', message: 'Location must be a string' };
  const t = raw.trim();
  if (t.length === 0) return { kind: 'clear' };
  if (t.length > CREATOR_LOCATION_MAX_LEN) {
    return { kind: 'error', message: `Location must be at most ${CREATOR_LOCATION_MAX_LEN} characters` };
  }
  return { kind: 'set', value: t };
}

/** Create: optional string only; omit or empty = no field. */
export function parseCreatorLocationForCreate(
  raw: unknown,
): { ok: true; value?: string } | { ok: false; error: string } {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: undefined };
  if (typeof raw !== 'string') return { ok: false, error: 'Location must be a string' };
  const t = raw.trim();
  if (t.length === 0) return { ok: true, value: undefined };
  if (t.length > CREATOR_LOCATION_MAX_LEN) {
    return { ok: false, error: `Location must be at most ${CREATOR_LOCATION_MAX_LEN} characters` };
  }
  return { ok: true, value: t };
}
