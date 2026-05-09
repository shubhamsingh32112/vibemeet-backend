import { createHash } from 'crypto';
import { DeletedUserIdentity, type DeletedIdentityType } from './deleted-user-identity.model';
import { DeletedUserPhone } from './deleted-user-phone.model';

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function normalizePhone(phone: string): string {
  // Firebase typically returns E.164 for phone. We keep it simple and stable.
  return phone.trim();
}

function buildHash(type: DeletedIdentityType, valueNormalized: string): string {
  return sha256Hex(`${type}:${valueNormalized}`);
}

export async function upsertDeletedIdentities(input: {
  email?: string | null;
  phone?: string | null;
  deletedAt?: Date;
}): Promise<void> {
  const deletedAt = input.deletedAt ?? new Date();

  const ops: Array<Promise<unknown>> = [];

  if (input.email && input.email.trim().length > 0) {
    const valueNormalized = normalizeEmail(input.email);
    const valueHash = buildHash('email', valueNormalized);
    ops.push(
      DeletedUserIdentity.findOneAndUpdate(
        { type: 'email', valueHash },
        { type: 'email', valueHash, valueNormalized, deletedAt },
        { upsert: true, new: true }
      )
    );
  }

  if (input.phone && input.phone.trim().length > 0) {
    const valueNormalized = normalizePhone(input.phone);
    const valueHash = buildHash('phone', valueNormalized);
    ops.push(
      DeletedUserIdentity.findOneAndUpdate(
        { type: 'phone', valueHash },
        { type: 'phone', valueHash, valueNormalized, deletedAt },
        { upsert: true, new: true }
      )
    );
  }

  await Promise.all(ops);
}

export async function checkDeletedStatus(input: {
  email?: string | null;
  phone?: string | null;
}): Promise<{
  isDeleted: boolean;
  matchedTypes: Array<DeletedIdentityType>;
}> {
  const matchedTypes: Array<DeletedIdentityType> = [];

  const checks: Array<Promise<{ type: DeletedIdentityType; found: boolean }>> = [];

  if (input.email && input.email.trim().length > 0) {
    const valueNormalized = normalizeEmail(input.email);
    const valueHash = buildHash('email', valueNormalized);
    checks.push(
      DeletedUserIdentity.exists({ type: 'email', valueHash }).then((doc) => ({
        type: 'email' as const,
        found: Boolean(doc),
      }))
    );
  }

  if (input.phone && input.phone.trim().length > 0) {
    const valueNormalized = normalizePhone(input.phone);
    const valueHash = buildHash('phone', valueNormalized);
    checks.push(
      (async () => {
        const foundNew = await DeletedUserIdentity.exists({ type: 'phone', valueHash });
        if (foundNew) return { type: 'phone' as const, found: true };
        // Back-compat: treat legacy DeletedUserPhone as deleted.
        const foundLegacy = await DeletedUserPhone.exists({ phone: valueNormalized });
        return { type: 'phone' as const, found: Boolean(foundLegacy) };
      })()
    );
  }

  const results = await Promise.all(checks);
  for (const r of results) {
    if (r.found) matchedTypes.push(r.type);
  }

  return { isDeleted: matchedTypes.length > 0, matchedTypes };
}

