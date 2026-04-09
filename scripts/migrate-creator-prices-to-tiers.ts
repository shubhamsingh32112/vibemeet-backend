/**
 * One-time: snap Creator.price to nearest allowed tier (60, 90, 120).
 * Run: npx ts-node -r tsconfig-paths/register scripts/migrate-creator-prices-to-tiers.ts
 * (adjust for your project's runner)
 */
import mongoose from 'mongoose';
import { Creator } from '../src/modules/creator/creator.model';
import { ALLOWED_CREATOR_PRICES, isAllowedCreatorPrice } from '../src/config/creator-price.config';

function nearestTier(price: number): number {
  let best = ALLOWED_CREATOR_PRICES[0];
  let bestDist = Math.abs(price - best);
  for (const t of ALLOWED_CREATOR_PRICES) {
    const d = Math.abs(price - t);
    if (d < bestDist || (d === bestDist && t < best)) {
      best = t;
      bestDist = d;
    }
  }
  return best;
}

async function main(): Promise<void> {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    console.error('Set MONGODB_URI');
    process.exit(1);
  }
  await mongoose.connect(uri);
  const all = await Creator.find({}).select('_id price').lean();
  let updated = 0;
  for (const c of all) {
    const p = c.price;
    if (isAllowedCreatorPrice(p)) continue;
    const next = nearestTier(Number(p) || 0);
    await Creator.updateOne({ _id: c._id }, { $set: { price: next } });
    console.log(`Creator ${c._id}: ${p} -> ${next}`);
    updated++;
  }
  console.log(`Done. Updated ${updated} creator(s).`);
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
