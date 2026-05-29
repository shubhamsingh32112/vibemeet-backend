/**
 * One-off / periodic backfill: write canonical creator:presence:{uid} v2 keys from legacy availability.
 *
 * Usage (from backend/):
 *   npx ts-node scripts/backfill-creator-presence-v2.ts
 *   npx ts-node scripts/backfill-creator-presence-v2.ts --uids=uid1,uid2
 */
import { backfillCreatorPresenceV2 } from '../src/modules/availability/presence-backfill.service';
import { logInfo, logError } from '../src/utils/logger';

async function main(): Promise<void> {
  const argUids = process.argv
    .find((a) => a.startsWith('--uids='))
    ?.split('=')[1]
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  logInfo('creator_presence_v2_backfill_start', {
    scoped: Boolean(argUids?.length),
    countHint: argUids?.length ?? null,
  });
  const result = await backfillCreatorPresenceV2({
    uids: argUids,
    source: 'backfill-creator-presence-v2',
  });
  logInfo('creator_presence_v2_backfill_done', result);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logError('creator_presence_v2_backfill_fatal', err);
    process.exit(1);
  });
