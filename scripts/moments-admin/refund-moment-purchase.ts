/**
 * Refund a moment purchase (symmetric ledger reversal).
 *
 * Usage:
 *   DRY_RUN=true npx ts-node -r tsconfig-paths/register scripts/moments-admin/refund-moment-purchase.ts \
 *     --purchaseId=... --reason="..." --ticketId=T-123 --confirm
 */
import mongoose from 'mongoose';
import { refundMomentPurchase } from '../../src/modules/moments/services/moment-purchase-admin.service';

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

  const purchaseId = readArg('purchaseId');
  const userId = readArg('userId');
  const momentId = readArg('momentId');
  const reason = readArg('reason');
  const ticketId = readArg('ticketId');
  const confirm = process.argv.includes('--confirm');
  const dryRun = process.env.DRY_RUN !== 'false';

  if (!reason || !ticketId || (!purchaseId && !(userId && momentId))) {
    console.error('Required: --reason --ticketId and (--purchaseId or --userId+--momentId)');
    process.exit(1);
  }
  if (!confirm && !dryRun) {
    console.error('Pass --confirm to write (or set DRY_RUN=true for preview)');
    process.exit(1);
  }

  await mongoose.connect(uri);
  const result = await refundMomentPurchase({
    purchaseId,
    userId,
    momentId,
    reason,
    ticketId,
    actor: process.env.ADMIN_ACTOR || 'cli',
    dryRun,
  });
  console.log(JSON.stringify({ dryRun, result }, null, 2));
  await mongoose.disconnect();
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
