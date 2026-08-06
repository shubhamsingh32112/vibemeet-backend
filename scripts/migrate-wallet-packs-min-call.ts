/**
 * Deactivate wallet coin packs with face value below MIN_COINS_TO_CALL (450).
 * Live WalletPricingConfig is not overwritten by DEFAULT_WALLET_COIN_PACKAGES
 * once a config document exists.
 *
 * Usage:
 *   npx tsx scripts/migrate-wallet-packs-min-call.ts --dry-run
 *   npx tsx scripts/migrate-wallet-packs-min-call.ts
 */
import mongoose from 'mongoose';
import { WalletPricingConfig } from '../src/modules/payment/wallet-pricing.model';

const MIN_PACK_COINS = 450;

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    console.error('Set MONGODB_URI or MONGO_URI');
    process.exit(1);
  }

  await mongoose.connect(uri);
  const config = await WalletPricingConfig.findOne().sort({ createdAt: 1 });
  if (!config) {
    console.log('No WalletPricingConfig document — defaults will apply on first create (already ≥450).');
    await mongoose.disconnect();
    return;
  }

  let changed = 0;
  for (const pack of config.packages) {
    if (pack.coins < MIN_PACK_COINS && pack.isActive) {
      console.log(
        `${dryRun ? 'Would deactivate' : 'Deactivating'} pack ${pack.coins} coins (was active)`
      );
      if (!dryRun) {
        pack.isActive = false;
      }
      changed++;
    }
  }

  if (!dryRun && changed > 0) {
    config.markModified('packages');
    await config.save();
  }

  console.log(
    dryRun
      ? `Dry-run: ${changed} pack(s) would be deactivated (coins < ${MIN_PACK_COINS}).`
      : `Done: ${changed} pack(s) deactivated (coins < ${MIN_PACK_COINS}).`
  );

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
