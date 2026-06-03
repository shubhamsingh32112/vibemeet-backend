import { isMomentsEnabled } from '../../config/moments';
import { isRedisConfigured } from '../../config/redis';
import { logInfo, logWarning } from '../../utils/logger';
import { sweepStaleStreamSessions } from '../stream/stream-upload-session.service';
import { drainAnalyticsQueue } from '../moments/services/analytics-emitter.service';
import {
  drainFanoutQueue,
  drainFeedWarmQueue,
} from '../moments/services/feed-fanout.service';
import { expireStoriesJob } from '../stories/controllers/stories.controller';
import { headUrlOk, isCloudflareStreamCircuitOpen } from '../stream/cloudflare-stream.client';
import { CreatorMoment } from '../moments/models/creator-moment.model';
import { buildStreamThumbnailUrl } from '../stream/cloudflare-stream.client';

let intervals: NodeJS.Timeout[] = [];
let started = false;

const SWEEPER_MS = 15 * 60 * 1000;
const ANALYTICS_MS = 30 * 1000;
const STORY_EXPIRY_MS = 30 * 60 * 1000;
const THUMBNAIL_MS = 10 * 60 * 1000;
const FANOUT_MS = 5 * 1000;
const FEED_WARM_MS = 10 * 1000;

async function validateThumbnailsBatch(): Promise<void> {
  if (isCloudflareStreamCircuitOpen()) return;
  const pending = await CreatorMoment.find({
    thumbnailValidated: { $ne: true },
    streamVideoId: { $ne: null },
    isDeleted: false,
  })
    .limit(20)
    .lean();
  for (const m of pending) {
    if (!m.streamVideoId) continue;
    const url = buildStreamThumbnailUrl(m.streamVideoId, 400);
    const ok = await headUrlOk(url);
    await CreatorMoment.updateOne(
      { _id: m._id },
      {
        $set: {
          thumbnailValidated: ok,
          thumbnailFallbackUrl: ok
            ? null
            : 'https://imagedelivery.net/static/placeholder/moments/thumb',
        },
      },
    );
  }
}

export function startMomentsWorkers(): void {
  if (started || !isMomentsEnabled()) {
    if (!isMomentsEnabled()) {
      logWarning('Moments workers disabled (USE_MOMENTS is not true)', {});
    }
    return;
  }
  started = true;

  intervals.push(
    setInterval(() => {
      void sweepStaleStreamSessions();
    }, SWEEPER_MS),
  );

  if (isRedisConfigured()) {
    intervals.push(
      setInterval(() => {
        void drainAnalyticsQueue(50);
      }, ANALYTICS_MS),
    );
    intervals.push(
      setInterval(() => {
        void drainFanoutQueue(10);
      }, FANOUT_MS),
    );
    intervals.push(
      setInterval(() => {
        void drainFeedWarmQueue(5);
      }, FEED_WARM_MS),
    );
  }

  intervals.push(
    setInterval(() => {
      void expireStoriesJob();
    }, STORY_EXPIRY_MS),
  );

  intervals.push(
    setInterval(() => {
      void validateThumbnailsBatch();
    }, THUMBNAIL_MS),
  );

  logInfo('Moments background workers started');
}

export function stopMomentsWorkers(): void {
  for (const t of intervals) clearInterval(t);
  intervals = [];
  started = false;
  logInfo('Moments background workers stopped');
}
