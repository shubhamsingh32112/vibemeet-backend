/**
 * BullMQ queue that hands blurhash generation off the request path.
 *
 * §6 of the plan mandates: commits NEVER block on blurhash. Sharp +
 * blurhash encoding can spike CPU for 100-300ms which compounds under
 * concurrency, so we enqueue and back-fill async.
 *
 * Queue config (locked):
 *   - lockDuration:     30s (per-job lease while sharp decodes)
 *   - concurrency:      env BLURHASH_CONCURRENCY (default 2)
 *   - attempts:         5 with exponential backoff
 *   - removeOnComplete: 200
 *   - removeOnFail:     500 (kept long for DLQ triage)
 */

import { Queue, type JobsOptions } from 'bullmq';
import { duplicateImageWorkerConnection } from './image-workers.connection';
import { blurhashJobId } from './blurhash.job-id';
import { logInfo, logWarning } from '../../utils/logger';
import { bumpImageCounter } from './image-metrics';

export { blurhashJobId } from './blurhash.job-id';

export const BLURHASH_QUEUE_NAME = 'image-blurhash';

export interface BlurhashJobData {
  imageId: string;
  /** Which collection owns this asset (so the worker knows where to patch). */
  target:
    | { kind: 'creator-avatar'; creatorId: string }
    | { kind: 'creator-gallery'; creatorId: string; galleryItemId: string }
    | { kind: 'user-avatar'; userId: string }
    | { kind: 'moment-image'; momentId: string }
    | { kind: 'story-image'; storyId: string };
  enqueuedAt: number;
  requestId?: string;
}

let queue: Queue<BlurhashJobData> | null = null;

export function getBlurhashQueue(): Queue<BlurhashJobData> {
  if (!queue) {
    queue = new Queue<BlurhashJobData>(BLURHASH_QUEUE_NAME, {
      connection: duplicateImageWorkerConnection(),
    });
  }
  return queue;
}

const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 1000 },
  removeOnComplete: 200,
  removeOnFail: 500,
};

export async function enqueueBlurhashJob(data: BlurhashJobData): Promise<void> {
  try {
    const q = getBlurhashQueue();
    await q.add('generate-blurhash', data, {
      ...DEFAULT_JOB_OPTIONS,
      jobId: blurhashJobId(data.imageId),
    });
    bumpImageCounter('blurhash.enqueued', { kind: data.target.kind });
  } catch (error) {
    // We tolerate enqueue failure — the asset is still usable without blurhash.
    logWarning('Failed to enqueue blurhash job', {
      imageId: data.imageId,
      kind: data.target.kind,
      error: (error as Error).message,
    });
    bumpImageCounter('blurhash.enqueue_failed', { kind: data.target.kind });
  }
}

export async function closeBlurhashQueue(): Promise<void> {
  if (queue) {
    await queue.close().catch(() => undefined);
    logInfo('blurhash queue closed');
    queue = null;
  }
}
