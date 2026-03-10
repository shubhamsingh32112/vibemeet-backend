import mongoose from 'mongoose';
import { IdentityLedger } from './identity-ledger.model';
import { logInfo, logDebug } from '../../utils/logger';

export interface IdentityInput {
  deviceFingerprint?: string | null;
  googleId?: string | null;
  phone?: string | null;
}

/**
 * Check if the given identity has already claimed the welcome bonus.
 * Returns true if eligible (can claim), false if not eligible (already claimed).
 */
export async function checkBonusEligibility(input: IdentityInput): Promise<boolean> {
  const conditions: Record<string, unknown>[] = [];

  if (input.deviceFingerprint && typeof input.deviceFingerprint === 'string') {
    const fp = input.deviceFingerprint.trim();
    if (fp.length > 0) conditions.push({ deviceFingerprint: fp });
  }
  if (input.googleId && typeof input.googleId === 'string') {
    const gid = input.googleId.trim();
    if (gid.length > 0) conditions.push({ googleId: gid });
  }
  if (input.phone && typeof input.phone === 'string') {
    const ph = input.phone.trim();
    if (ph.length > 0) conditions.push({ phone: ph });
  }

  if (conditions.length === 0) {
    logDebug('Identity service: no identity provided, treating as eligible');
    return true;
  }

  const existing = await IdentityLedger.findOne({
    $or: conditions,
    bonusClaimed: true,
  }).lean();

  const eligible = !existing;
  if (!eligible) {
    logInfo('Identity service: bonus already claimed for identity', {
      hasDeviceFingerprint: !!input.deviceFingerprint,
      hasGoogleId: !!input.googleId,
      hasPhone: !!input.phone,
      firstUserId: existing?.firstUserId?.toString(),
    });
  }
  return eligible;
}

/**
 * Build $or filter conditions from identity input.
 */
function buildOrConditions(input: IdentityInput): Record<string, unknown>[] {
  const conditions: Record<string, unknown>[] = [];
  if (input.deviceFingerprint && typeof input.deviceFingerprint === 'string') {
    const fp = input.deviceFingerprint.trim();
    if (fp.length > 0) conditions.push({ deviceFingerprint: fp });
  }
  if (input.googleId && typeof input.googleId === 'string') {
    const gid = input.googleId.trim();
    if (gid.length > 0) conditions.push({ googleId: gid });
  }
  if (input.phone && typeof input.phone === 'string') {
    const ph = input.phone.trim();
    if (ph.length > 0) conditions.push({ phone: ph });
  }
  return conditions;
}

/**
 * Atomically try to claim the welcome bonus in the ledger.
 * Only the first request succeeds; concurrent requests get false.
 * Returns true if this request "won" (upserted), false if identity already claimed.
 */
export async function tryClaimBonusInLedger(
  input: IdentityInput & { firstUserId: mongoose.Types.ObjectId }
): Promise<boolean> {
  const conditions = buildOrConditions(input);
  if (conditions.length === 0) {
    logInfo('Identity service: no identity for claim attempt', {
      userId: input.firstUserId.toString(),
    });
    return false;
  }

  // Filter: match docs that have our identity AND bonus already claimed.
  // If we match → we lost the race, don't insert.
  // If we don't match → upsert creates new doc, we won.
  const filter = {
    $or: conditions,
    bonusClaimed: true,
  };

  const setOnInsert: Record<string, unknown> = {
    bonusClaimed: true,
    firstUserId: input.firstUserId,
  };
  if (input.deviceFingerprint?.trim()) setOnInsert.deviceFingerprint = input.deviceFingerprint.trim();
  if (input.googleId?.trim()) setOnInsert.googleId = input.googleId.trim();
  if (input.phone?.trim()) setOnInsert.phone = input.phone.trim();

  const result = await IdentityLedger.updateOne(
    filter,
    { $setOnInsert: setOnInsert },
    { upsert: true }
  );

  const won = result.upsertedCount === 1;
  if (won) {
    logInfo('Identity service: bonus claim recorded (atomic upsert)', {
      userId: input.firstUserId.toString(),
    });
  }
  return won;
}

/**
 * Record that the welcome bonus was claimed for the given identity.
 * @deprecated Use tryClaimBonusInLedger for atomic claim. Kept for migration/backfill.
 */
export async function recordBonusClaim(
  input: IdentityInput & { firstUserId: mongoose.Types.ObjectId }
): Promise<void> {
  const doc: Record<string, unknown> = {
    bonusClaimed: true,
    firstUserId: input.firstUserId,
  };
  if (input.deviceFingerprint?.trim()) doc.deviceFingerprint = input.deviceFingerprint.trim();
  if (input.googleId?.trim()) doc.googleId = input.googleId.trim();
  if (input.phone?.trim()) doc.phone = input.phone.trim();

  if (!doc.deviceFingerprint && !doc.googleId && !doc.phone) {
    logInfo('Identity service: no identity to record', { userId: input.firstUserId.toString() });
    return;
  }

  await IdentityLedger.create(doc);
  logInfo('Identity service: bonus claim recorded', { userId: input.firstUserId.toString() });
}
