import { Router } from 'express';
import { verifyFirebaseToken } from '../../middlewares/auth.middleware';
import { imageDirectUploadLimiter } from '../../middlewares/rate-limit.middleware';
import {
  createDirectUploadHandler,
  getImagesHealthHandler,
  getPresetAvatarsHandler,
} from './images.controller';

const router = Router();

// Cloudflare Images pipeline health (mirrors USE_CLOUDFLARE_IMAGES flag).
router.get('/health', getImagesHealthHandler);

// Authenticated routes.
router.post(
  '/direct-upload',
  verifyFirebaseToken,
  imageDirectUploadLimiter,
  createDirectUploadHandler,
);
router.get('/presets', verifyFirebaseToken, getPresetAvatarsHandler);

export default router;
