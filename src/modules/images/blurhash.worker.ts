/**
 * Worker for the `image-blurhash` queue.
 *
 * Pipeline:
 *   1. Download the public-variant bytes via Cloudflare client.
 *   2. Decode + downscale to a small RGBA buffer with `sharp`.
 *   3. Encode the blurhash (4x3 components — small, dense, fast).
 *   4. Patch the owning document (Creator/User) with the blurhash.
 *
 * Failures:
 *   - Cloudflare 404 → asset was deleted before we ran. Drop the job (no retry).
 *   - sharp decode error → BullMQ retries with backoff; after 5 attempts the
 *     job lands in `failed` and is preserved 500 deep for DLQ inspection.
 *
 * Concurrency: BLURHASH_CONCURRENCY (default 2). Keep low because sharp
 * decodes are CPU-bound and our backend instances are typically 1 vCPU.
 */

import { Worker, type Job } from 'bullmq';
import sharp from 'sharp';
import { encode as encodeBlurhash } from 'blurhash';
import mongoose from 'mongoose';
import { duplicateImageWorkerConnection } from './image-workers.connection';
import { downloadImageBytes, CloudflareImagesError } from './cloudflare.client';
import { BLURHASH_QUEUE_NAME, type BlurhashJobData } from './blurhash.queue';
import { Creator } from '../creator/creator.model';
import { User } from '../user/user.model';
import { logError, logInfo, logWarning } from '../../utils/logger';
import { bumpImageCounter, recordImageMetric } from './image-metrics';

const DEFAULT_CONCURRENCY = 2;
const DEFAULT_LOCK_DURATION_MS = 30_000;
const BLURHASH_X_COMPONENTS = 4;
const BLURHASH_Y_COMPONENTS = 3;
/** Downscale long edge before encoding; keeps blurhash CPU-bounded. */
const TARGET_LONG_EDGE = 64;

let worker: Worker<BlurhashJobData> | null = null;

function readConcurrency(): number {
  const raw = parseInt(process.env.BLURHASH_CONCURRENCY || '', 10);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_CONCURRENCY;
  return Math.min(8, raw);
}

async function generateBlurhashFromBytes(bytes: Buffer): Promise<string> {
  const image = sharp(bytes, { failOn: 'error' })
    .rotate() // honour EXIF orientation
    .resize({ width: TARGET_LONG_EDGE, height: TARGET_LONG_EDGE, fit: 'inside' });
  const { data, info } = await image
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  return encodeBlurhash(
    new Uint8ClampedArray(data),
    info.width,
    info.height,
    BLURHASH_X_COMPONENTS,
    BLURHASH_Y_COMPONENTS,
  );
}

async function applyBlurhashToTarget(
  data: BlurhashJobData,
  blurhash: string,
): Promise<boolean> {
  if (data.target.kind === 'creator-avatar') {
    const creatorId = new mongoose.Types.ObjectId(data.target.creatorId);
    const result = await Creator.updateOne(
      { _id: creatorId, 'avatar.imageId': data.imageId },
      { $set: { 'avatar.blurhash': blurhash } },
    );
    return result.modifiedCount > 0;
  }
  if (data.target.kind === 'creator-gallery') {
    const creatorId = new mongoose.Types.ObjectId(data.target.creatorId);
    const result = await Creator.updateOne(
      { _id: creatorId, 'galleryImages.id': data.target.galleryItemId },
      { $set: { 'galleryImages.$.asset.blurhash': blurhash } },
    );
    return result.modifiedCount > 0;
  }
  if (data.target.kind === 'user-avatar') {
    const userId = new mongoose.Types.ObjectId(data.target.userId);
    const result = await User.updateOne(
      { _id: userId, 'avatar.imageId': data.imageId },
      { $set: { 'avatar.blurhash': blurhash } },
    );
    return result.modifiedCount > 0;
  }
  return false;
}

async function processBlurhashJob(job: Job<BlurhashJobData>): Promise<void> {
  const startedAt = Date.now();
  const { imageId, target } = job.data;
  try {
    const bytes = await downloadImageBytes(imageId);
    const blurhash = await generateBlurhashFromBytes(bytes);
    const applied = await applyBlurhashToTarget(job.data, blurhash);
    recordImageMetric('blurhash.duration_ms', Date.now() - startedAt, {
      kind: target.kind,
      applied,
    });
    if (applied) {
      bumpImageCounter('blurhash.applied', { kind: target.kind });
    } else {
      // The asset was likely replaced (avatar swap, gallery deletion).
      bumpImageCounter('blurhash.target_missing', { kind: target.kind });
    }
  } catch (error) {
    if (error instanceof CloudflareImagesError && error.status === 404) {
      bumpImageCounter('blurhash.cloudflare_missing', { kind: target.kind });
      logWarning('blurhash worker: image gone from Cloudflare, dropping job', { imageId });
      return;
    }
    bumpImageCounter('blurhash.error', { kind: target.kind });
    throw error;
  }
}

export function startBlurhashWorker(): void {
  if (worker) return;
  worker = new Worker<BlurhashJobData>(BLURHASH_QUEUE_NAME, processBlurhashJob, {
    connection: duplicateImageWorkerConnection(),
    concurrency: readConcurrency(),
    lockDuration: DEFAULT_LOCK_DURATION_MS,
  });
  worker.on('failed', (job, error) => {
    logError('blurhash worker job failed', error, {
      imageId: job?.data.imageId,
      attemptsMade: job?.attemptsMade,
      kind: job?.data.target.kind,
    });
  });
  worker.on('completed', (job) => {
    bumpImageCounter('blurhash.completed', { kind: job.data.target.kind });
  });
  logInfo('blurhash worker started', { concurrency: readConcurrency() });
}

export async function stopBlurhashWorker(): Promise<void> {
  if (!worker) return;
  await worker.close().catch(() => undefined);
  worker = null;
  logInfo('blurhash worker stopped');
}
