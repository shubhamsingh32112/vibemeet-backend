/**
 * Scheduler + worker that deletes orphaned Cloudflare images.
 *
 * "Orphan" here means: a direct-upload session existed in Redis but
 * was never committed (client crashed, network failure, malicious abuser).
 * We expire the session in Redis on TTL; this job sweeps the expired-index,
 * issues DELETE to Cloudflare for each abandoned imageId, and removes the
 * Redis bookkeeping.
 *
 * Schedule: every 30 minutes (configurable via env IMAGE_ORPHAN_CRON_MS).
 * Concurrency: 1 (only one sweeper at a time).
 */

import { Queue, Worker, type Job } from 'bullmq';
import { duplicateImageWorkerConnection } from './image-workers.connection';
import { listExpiredSessions, removeSessionFromIndex } from './upload-session.service';
import { deleteImage, CloudflareImagesError } from './cloudflare.client';
import { logError, logInfo } from '../../utils/logger';
import { bumpImageCounter } from './image-metrics';

export const ORPHAN_CLEANUP_QUEUE_NAME = 'image-orphan-cleanup';
const SWEEP_JOB_NAME = 'sweep';
const DEFAULT_INTERVAL_MS = 30 * 60 * 1000;

let queue: Queue | null = null;
let worker: Worker | null = null;

function readIntervalMs(): number {
  const raw = parseInt(process.env.IMAGE_ORPHAN_CRON_MS || '', 10);
  if (!Number.isFinite(raw) || raw < 60_000) return DEFAULT_INTERVAL_MS;
  return Math.min(24 * 60 * 60 * 1000, raw);
}

function readBatchSize(): number {
  const raw = parseInt(process.env.IMAGE_ORPHAN_BATCH_SIZE || '', 10);
  if (!Number.isFinite(raw) || raw <= 0) return 100;
  return Math.min(1000, raw);
}

function getQueue(): Queue {
  if (!queue) {
    queue = new Queue(ORPHAN_CLEANUP_QUEUE_NAME, {
      connection: duplicateImageWorkerConnection(),
    });
  }
  return queue;
}

async function processSweep(_job: Job): Promise<void> {
  const batchSize = readBatchSize();
  const expired = await listExpiredSessions(batchSize);
  if (expired.length === 0) {
    bumpImageCounter('orphan.sweep_empty');
    return;
  }
  let deleted = 0;
  let missing = 0;
  let failed = 0;
  for (const session of expired) {
    try {
      await deleteImage(session.imageId);
      deleted += 1;
    } catch (error) {
      if (error instanceof CloudflareImagesError && error.status === 404) {
        missing += 1;
      } else {
        failed += 1;
        logError('orphan-cleanup: deleteImage failed', error, {
          imageId: session.imageId,
          sessionId: session.sessionId,
        });
      }
    }
    await removeSessionFromIndex(session.sessionId);
  }
  bumpImageCounter('orphan.sweep_done', { deleted, missing, failed });
  logInfo('orphan-cleanup sweep complete', {
    candidates: expired.length,
    deleted,
    missing,
    failed,
  });
}

async function scheduleRecurring(): Promise<void> {
  const q = getQueue();
  const interval = readIntervalMs();
  // Remove previous repeat key to avoid duplicate schedules across rolling deploys.
  const repeats = await q.getRepeatableJobs();
  for (const repeat of repeats) {
    if (repeat.name === SWEEP_JOB_NAME) {
      await q.removeRepeatableByKey(repeat.key);
    }
  }
  await q.add(
    SWEEP_JOB_NAME,
    { startedAt: Date.now() },
    {
      repeat: { every: interval },
      removeOnComplete: 100,
      removeOnFail: 50,
    },
  );
}

export async function startOrphanCleanupWorker(): Promise<void> {
  if (worker) return;
  worker = new Worker(ORPHAN_CLEANUP_QUEUE_NAME, processSweep, {
    connection: duplicateImageWorkerConnection(),
    concurrency: 1,
    lockDuration: 10 * 60 * 1000,
  });
  worker.on('failed', (job, error) => {
    logError('orphan-cleanup worker failed', error, {
      jobId: job?.id,
      attemptsMade: job?.attemptsMade,
    });
  });
  await scheduleRecurring();
  logInfo('orphan-cleanup worker started', { intervalMs: readIntervalMs() });
}

export async function stopOrphanCleanupWorker(): Promise<void> {
  if (worker) {
    await worker.close().catch(() => undefined);
    worker = null;
  }
  if (queue) {
    await queue.close().catch(() => undefined);
    queue = null;
  }
  logInfo('orphan-cleanup worker stopped');
}
