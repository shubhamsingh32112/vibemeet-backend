/**
 * Regrant moment entitlement (support recovery).
 *
 * Usage:
 *   DRY_RUN=true npx ts-node -r tsconfig-paths/register scripts/moments-admin/regrant-entitlement.ts \
 *     --userId=... --momentId=... --reason="..." --ticketId=T-123 --confirm
 */
import mongoose from 'mongoose';
import { regrantMomentEntitlement } from '../../src/modules/moments/services/moment-purchase-admin.service';

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

async function main(): Promise<void> {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    console.error('Set MONGODB_URI');
    process.exit(1);
  }

  const userId = readArg('userId');
  const momentId = readArg('momentId');
  const reason = readArg('reason');
  const ticketId = readArg('ticketId');
  const confirm = process.argv.includes('--confirm');
  const dryRun = process.env.DRY_RUN !== 'false';
  const forceRepair = process.argv.includes('--force-repair');
  const skipLedger = process.argv.includes('--skip-ledger');

  if (!userId || !momentId || !reason || !ticketId) {
    console.error('Required: --userId --momentId --reason --ticketId');
    process.exit(1);
  }
  if (!confirm && !dryRun) {
    console.error('Pass --confirm to write (or set DRY_RUN=true for preview)');
    process.exit(1);
  }

  await mongoose.connect(uri);
  const result = await regrantMomentEntitlement({
    userId,
    momentId,
    reason,
    ticketId,
    actor: process.env.ADMIN_ACTOR || 'cli',
    forceRepair,
    skipLedger,
    dryRun,
  });
  console.log(JSON.stringify({ dryRun, result }, null, 2));
  await mongoose.disconnect();
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
