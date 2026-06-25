import { getRedis, isRedisConfigured } from '../../../config/redis';
import { getMomentsConfig } from '../../../config/moments';
import { AnalyticsEvent, type AnalyticsEventType } from '../models/analytics-event.model';
import { CreatorMoment } from '../models/creator-moment.model';
import { logWarning } from '../../../utils/logger';

const QUEUE_KEY = 'analytics:events';
const DLQ_KEY = 'analytics:dead_letter';

export interface AnalyticsEventPayload {
  type: AnalyticsEventType;
  userId?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
}

function validateEvent(event: AnalyticsEventPayload): void {
  if (!event.type) throw new Error('missing type');
}

export async function enqueueAnalyticsEvent(event: AnalyticsEventPayload): Promise<void> {
  if (!isRedisConfigured()) {
    try {
      validateEvent(event);
      await AnalyticsEvent.create({
        type: event.type,
        userId: event.userId ?? null,
        targetId: event.targetId ?? null,
        metadata: event.metadata ?? {},
      });
      await updateCountersAsync(event);
    } catch (err) {
      logWarning('Analytics direct insert failed', { error: String(err) });
    }
    return;
  }

  try {
    validateEvent(event);
    await getRedis().rpush(QUEUE_KEY, JSON.stringify({ ...event, ts: Date.now() }));
  } catch (err) {
    await getRedis().rpush(
      DLQ_KEY,
      JSON.stringify({ event, error: String(err), ts: Date.now() }),
    );
  }
}

async function dedupeImpression(key: string): Promise<boolean> {
  const cfg = getMomentsConfig();
  if (!isRedisConfigured()) return true;
  const set = await getRedis().set(key, '1', 'EX', cfg.impressionDedupTtlSec, 'NX');
  return set === 'OK';
}

export async function emitMomentViewed(userId: string, momentId: string): Promise<void> {
  const dedupKey = `viewed:${userId}:${momentId}`;
  if (!(await dedupeImpression(dedupKey))) return;
  await enqueueAnalyticsEvent({ type: 'moment_viewed', userId, targetId: momentId });
}

/** Paywall impression — distinct from consumption (moment_viewed). */
export async function emitMomentsPaywallShown(
  userId: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  const source = typeof metadata?.source === 'string' ? metadata.source : 'unknown';
  const dedupKey = `paywall:moments:${userId}:${source}`;
  if (!(await dedupeImpression(dedupKey))) return;
  await enqueueAnalyticsEvent({
    type: 'moments_paywall_shown',
    userId,
    metadata: { accessReason: 'DENIED', ...metadata },
  });
}

export async function emitMomentCompleted(
  userId: string,
  momentId: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  const dedupKey = `completed:moment:${userId}:${momentId}`;
  if (!(await dedupeImpression(dedupKey))) return;
  await enqueueAnalyticsEvent({
    type: 'moment_completed',
    userId,
    targetId: momentId,
    metadata,
  });
}

export async function emitStoryCompleted(
  userId: string,
  storyId: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  const dedupKey = `completed:story:${userId}:${storyId}`;
  if (!(await dedupeImpression(dedupKey))) return;
  await enqueueAnalyticsEvent({
    type: 'story_completed',
    userId,
    targetId: storyId,
    metadata,
  });
}

async function updateCountersAsync(event: AnalyticsEventPayload): Promise<void> {
  if (!event.targetId) return;
  try {
    if (event.type === 'moment_viewed') {
      await CreatorMoment.updateOne({ _id: event.targetId }, { $inc: { viewsCount: 1 } });
    }
    // story_opened: viewsCount is incremented in recordStoryViewHandler when
    // the StoryView doc is created — do not double-count here.
  } catch (err) {
    logWarning('Analytics counter update failed', { error: String(err), type: event.type });
  }
}

export async function drainAnalyticsQueue(batchSize = 50): Promise<number> {
  if (!isRedisConfigured()) return 0;
  let processed = 0;
  for (let i = 0; i < batchSize; i++) {
    const raw = await getRedis().lpop(QUEUE_KEY);
    if (!raw) break;
    try {
      const event = JSON.parse(raw) as AnalyticsEventPayload;
      validateEvent(event);
      await AnalyticsEvent.create({
        type: event.type,
        userId: event.userId ?? null,
        targetId: event.targetId ?? null,
        metadata: event.metadata ?? {},
      });
      await updateCountersAsync(event);
      processed++;
    } catch (err) {
      await getRedis().rpush(DLQ_KEY, raw);
      logWarning('Analytics event moved to DLQ', { error: String(err) });
    }
  }
  return processed;
}
