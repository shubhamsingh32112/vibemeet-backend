/**
 * Client-instrumentation telemetry endpoints.
 *
 * These routes accept best-effort observability payloads from the Flutter
 * client (and any web clients). All endpoints MUST be:
 *   - rate-limited (telemetry can never DDoS the API)
 *   - non-blocking (drop, do not 5xx)
 *   - validated (a buggy client cannot poison aggregates)
 */

import { Router } from 'express';
import { verifyFirebaseToken } from '../../middlewares/auth.middleware';
import { imageRenderMetricsLimiter, videoPlaybackMetricsLimiter } from '../../middlewares/rate-limit.middleware';
import { postImageRenderMetricsHandler } from './image-render-metrics.controller';
import { postVideoPlaybackMetricsHandler } from './video-playback-metrics.controller';

const router = Router();

router.post(
  '/image-render',
  verifyFirebaseToken,
  imageRenderMetricsLimiter,
  postImageRenderMetricsHandler,
);

router.post(
  '/video-playback',
  verifyFirebaseToken,
  videoPlaybackMetricsLimiter,
  postVideoPlaybackMetricsHandler,
);

export default router;
