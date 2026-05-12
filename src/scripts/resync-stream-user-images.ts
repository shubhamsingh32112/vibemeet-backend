/**
 * Phase E.5 — Force-resync Stream Chat avatars to canonical Cloudflare URLs.
 *
 * Stream Chat persists `user.image` server-side. After Phase E hard-removes
 * the legacy `creator.photo` string and the legacy `user.avatar` string,
 * Stream's stored avatar URLs can still point at old Firebase Storage paths
 * that no longer resolve (channel previews and member avatars render broken
 * icons until something else triggers an upsert).
 *
 * This script:
 *   1. Iterates every User with a populated Cloudflare `avatar.imageId`.
 *   2. For each, computes `name` + `image` via `getStreamUpsertPayload`
 *      (which already pulls creator-side avatar when role = creator/admin).
 *   3. Calls `ensureStreamUser` so Stream's stored copy is overwritten with
 *      the canonical Cloudflare `avatarMd` URL.
 *
 * Idempotent. Safe to re-run. Logs progress every 100 users.
 *
 * Run:
 *   npm run resync:stream-images
 *   npm run resync:stream-images -- --limit 50         # only first 50 users
 *   npm run resync:stream-images -- --dry-run          # report, don't upsert
 */

import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { User } from '../modules/user/user.model';
import { Creator } from '../modules/creator/creator.model';
import { ensureStreamUser } from '../config/stream';
import { getStreamUpsertPayload } from '../utils/stream-user-payload';

dotenv.config();

interface CliFlags {
  limit?: number;
  dryRun: boolean;
}

function parseCli(argv: string[]): CliFlags {
  const flags: CliFlags = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      flags.dryRun = true;
    } else if (arg === '--limit') {
      const next = argv[i + 1];
      const n = Number.parseInt(next ?? '', 10);
      if (Number.isFinite(n) && n > 0) {
        flags.limit = n;
        i++;
      }
    }
  }
  return flags;
}

async function connectMongo(): Promise<void> {
  // Codebase convention is `MONGO_URI` (see backend/src/config/database.ts);
  // accept the rarer `MONGODB_URI` spelling as a fallback so a local
  // operator with the alternate name doesn't get a confusing failure.
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) {
    throw new Error('MONGO_URI is not set; cannot run resync script.');
  }
  await mongoose.connect(uri);
}

async function main(): Promise<void> {
  const flags = parseCli(process.argv.slice(2));
  console.log(`▶️  resync-stream-user-images started`, flags);

  await connectMongo();

  // Use a streaming cursor so the heap stays flat on large datasets.
  const cursor = User.find({ 'avatar.imageId': { $exists: true, $ne: null } })
    .sort({ _id: 1 })
    .cursor();

  let processed = 0;
  let resynced = 0;
  let skippedNoFirebaseUid = 0;
  let failed = 0;
  const failures: Array<{ userId: string; reason: string }> = [];

  for await (const userDoc of cursor) {
    processed += 1;

    if (!userDoc.firebaseUid) {
      skippedNoFirebaseUid += 1;
      continue;
    }

    try {
      const payload = await getStreamUpsertPayload(userDoc);

      if (!payload.image) {
        // No Cloudflare avatar resolved (e.g. moderation rejected) — skip
        // so we don't accidentally null out an OK Stream avatar.
        continue;
      }

      if (!flags.dryRun) {
        await ensureStreamUser(userDoc.firebaseUid, payload);
      }
      resynced += 1;
    } catch (err) {
      failed += 1;
      failures.push({
        userId: userDoc._id.toString(),
        reason: err instanceof Error ? err.message : String(err),
      });
    }

    if (processed % 100 === 0) {
      console.log(
        `… processed ${processed} | resynced ${resynced} | failed ${failed}`,
      );
    }

    if (flags.limit && processed >= flags.limit) {
      break;
    }
  }

  // Sanity: confirm Creator.avatar is the only legacy/photo-related field left.
  // (Pure observability — does not mutate anything.)
  const creatorsMissingAvatar = await Creator.countDocuments({
    $or: [{ avatar: null }, { avatar: { $exists: false } }],
  });

  console.log('');
  console.log('═══ resync-stream-user-images summary ═══');
  console.log(`processed:              ${processed}`);
  console.log(`resynced:               ${resynced}`);
  console.log(`skipped (no firebase):  ${skippedNoFirebaseUid}`);
  console.log(`failed:                 ${failed}`);
  console.log(`creators w/o avatar:    ${creatorsMissingAvatar}`);
  if (flags.dryRun) {
    console.log(`mode:                   DRY RUN (no Stream upserts)`);
  }

  if (failures.length > 0) {
    console.log('');
    console.log('First 10 failures:');
    for (const f of failures.slice(0, 10)) {
      console.log(`  • ${f.userId} — ${f.reason}`);
    }
  }

  await mongoose.disconnect();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error('❌ resync-stream-user-images fatal', err);
  try {
    await mongoose.disconnect();
  } catch {
    // ignore
  }
  process.exit(1);
});
