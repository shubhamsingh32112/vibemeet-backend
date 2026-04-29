/**
 * One-shot repair: persist tokenized Firebase download URLs for gallery images
 * that still lack `token=` in the stored URL. Run before enabling
 * DISABLE_GALLERY_REPAIR_ON_READ on the server.
 *
 * Run: npx tsx src/scripts/backfill-gallery-urls.ts
 */

import dotenv from 'dotenv';
dotenv.config();

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import mongoose from 'mongoose';
import { Creator } from '../modules/creator/creator.model';
import { resolveGalleryImageUrlsForApi } from '../modules/creator/creator-gallery-resolve';

const CONCURRENCY = 5;
const MAX_ATTEMPTS = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) {
    console.error('MONGO_URI missing');
    process.exit(1);
  }

  await mongoose.connect(mongoUri);
  console.log('Backfill gallery URLs — connected\n');

  const ids = await Creator.find({
    galleryImages: { $elemMatch: { url: { $not: /token=/ } } },
  })
    .distinct('_id');

  console.log(`Creators with at least one gallery URL missing token=: ${ids.length}\n`);

  let next = 0;
  let updated = 0;
  let errors = 0;
  const failedIds: string[] = [];

  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= ids.length) return;
      const oid = ids[i] as mongoose.Types.ObjectId;
      const idStr = oid.toString();
      try {
        let attempt = 0;
        for (;;) {
          attempt += 1;
          try {
            const full = await Creator.findById(oid);
            if (!full) break;
            const { galleryImages, urlsChanged } = await resolveGalleryImageUrlsForApi(
              full.galleryImages,
            );
            if (urlsChanged) {
              await Creator.updateOne({ _id: full._id }, { $set: { galleryImages } });
              updated++;
              if (updated % 10 === 0) {
                console.log(`  progress: ${updated} updated…`);
              }
            }
            break;
          } catch (inner) {
            if (attempt >= MAX_ATTEMPTS) throw inner;
            const backoffMs = attempt === 1 ? 500 : attempt === 2 ? 2000 : 8000;
            console.warn(`  [${idStr}] attempt ${attempt} failed; retrying in ${backoffMs}ms`);
            await sleep(backoffMs);
          }
        }
      } catch (e) {
        errors++;
        failedIds.push(idStr);
        console.error(`  [${idStr}]`, e);
      }
    }
  };

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  if (failedIds.length > 0) {
    const outPath = join(process.cwd(), 'backfill-gallery-urls-failed.json');
    writeFileSync(outPath, JSON.stringify({ failedIds }, null, 2), 'utf8');
    console.log(`\nWrote failed ids to: ${outPath}`);
  }

  console.log(`\nDone: ${updated} creator(s) updated, ${errors} error(s).`);
  await mongoose.disconnect();
  process.exit(errors > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
