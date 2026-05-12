/**
 * Image pipeline bootstrap.
 * Spawns the blurhash + orphan-cleanup workers when:
 *   - USE_CLOUDFLARE_IMAGES=true, AND
 *   - Redis is configured (BullMQ requirement).
 *
 * The image controller endpoints work without workers running (e.g. on a
 * pure web-tier instance), but you should always start at least one node
 * with workers enabled, otherwise blurhashes never materialize.
 */

import { isCloudflareImagesEnabled, tryGetCloudflareConfig } from '../../config/cloudflare';
import { isRedisConfigured } from '../../config/redis';
import { startBlurhashWorker, stopBlurhashWorker } from './blurhash.worker';
import { startOrphanCleanupWorker, stopOrphanCleanupWorker } from './orphan-cleanup.queue';
import { closeBlurhashQueue } from './blurhash.queue';
import { closeImageWorkerConnection } from './image-workers.connection';
import { logInfo, logWarning } from '../../utils/logger';

let started = false;

export async function startImagePipelineWorkers(): Promise<void> {
  if (started) return;
  if (!isCloudflareImagesEnabled()) {
    logWarning('Image pipeline workers disabled (USE_CLOUDFLARE_IMAGES is not true)', {});
    return;
  }
  if (!tryGetCloudflareConfig()) {
    logWarning('Image pipeline workers skipped (Cloudflare credentials missing)', {});
    return;
  }
  if (!isRedisConfigured()) {
    logWarning('Image pipeline workers skipped (Redis is not configured)', {});
    return;
  }
  startBlurhashWorker();
  await startOrphanCleanupWorker();
  started = true;
  logInfo('Image pipeline workers started');
}

export async function stopImagePipelineWorkers(): Promise<void> {
  if (!started) return;
  await stopBlurhashWorker();
  await stopOrphanCleanupWorker();
  await closeBlurhashQueue();
  await closeImageWorkerConnection();
  started = false;
  logInfo('Image pipeline workers stopped');
}
