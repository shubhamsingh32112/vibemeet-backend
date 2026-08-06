/**
 * One-time: map Creator.price from legacy tiers (60/90/120) to new tiers (1800/2700/3600).
 *
 * Explicit map (preferred):
 *   60  → 1800
 *   90  → 2700
 *   120 → 3600
 * Already on {1800,2700,3600}: no-op
 * Other values: nearest allowed tier
 *
 * Usage:
 *   npx tsx scripts/migrate-creator-prices-to-tiers.ts --dry-run
 *   npx tsx scripts/migrate-creator-prices-to-tiers.ts
 *
 * After apply: pricing Redis cache is ~5 min TTL per creator; restart api-ws or wait,
 * or call invalidateCreatorPricingCache when editing hosts. In-flight bill sessions keep
 * their session snapshot price until hangup.
 */
import mongoose from 'mongoose';
import { Creator } from '../src/modules/creator/creator.model';
import {
  ALLOWED_CREATOR_PRICES,
  isAllowedCreatorPrice,
} from '../src/config/creator-price.config';

const LEGACY_TIER_MAP: Record<number, number> = {
  60: 1800,
  90: 2700,
  120: 3600,
};

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

function mapPrice(price: number): { next: number; reason: 'noop' | 'legacy_map' | 'nearest' } {
  if (isAllowedCreatorPrice(price)) {
    return { next: price, reason: 'noop' };
  }
  if (Object.prototype.hasOwnProperty.call(LEGACY_TIER_MAP, price)) {
    return { next: LEGACY_TIER_MAP[price]!, reason: 'legacy_map' };
  }
  return { next: nearestTier(Number.isFinite(price) ? price : 0), reason: 'nearest' };
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    console.error('Set MONGODB_URI or MONGO_URI');
    process.exit(1);
  }

  await mongoose.connect(uri);
  const all = await Creator.find({}).select('_id price').lean();

  const counts = new Map<string, number>();
  let wouldUpdate = 0;

  for (const c of all) {
    const p = Number(c.price) || 0;
    const { next, reason } = mapPrice(p);
    const key = `${p} -> ${next} (${reason})`;
    counts.set(key, (counts.get(key) || 0) + 1);
    if (reason === 'noop') continue;
    wouldUpdate++;
    if (!dryRun) {
      await Creator.updateOne({ _id: c._id }, { $set: { price: next } });
      console.log(`Creator ${c._id}: ${p} -> ${next} [${reason}]`);
    }
  }

  console.log(dryRun ? 'Dry-run summary (no writes):' : 'Apply summary:');
  for (const [k, n] of [...counts.entries()].sort()) {
    console.log(`  ${n}x  ${k}`);
  }
  console.log(
    dryRun
      ? `Would update ${wouldUpdate} creator(s) of ${all.length} total.`
      : `Updated ${wouldUpdate} creator(s) of ${all.length} total.`
  );
  console.log(
    'Note: pricing cache TTL ~5 min; restart api-ws or wait for cache expiry after production apply.'
  );

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
