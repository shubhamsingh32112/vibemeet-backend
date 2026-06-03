/**
 * Audit a moment purchase by userId, momentId, and/or transactionId.
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register scripts/moments-admin/audit-moment-purchase.ts --userId=... --momentId=...
 */
import mongoose from 'mongoose';
import { auditMomentPurchase } from '../../src/modules/moments/services/moment-purchase-admin.service';

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
  const transactionId = readArg('transactionId');
  if (!userId && !momentId && !transactionId) {
    console.error('Provide at least one of --userId, --momentId, --transactionId');
    process.exit(1);
  }

  await mongoose.connect(uri);
  const audit = await auditMomentPurchase({ userId, momentId, transactionId });
  console.log(JSON.stringify(audit, null, 2));
  await mongoose.disconnect();
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
