import { Router } from 'express';
import { verifyFirebaseToken } from '../../middlewares/auth.middleware';
import {
  createDirectUploadHandler,
  getUploadStatusHandler,
  handleStreamWebhook,
  getStreamHealthHandler,
} from './stream.controller';

const router = Router();

router.get('/health', getStreamHealthHandler);

router.post('/direct-upload', verifyFirebaseToken, createDirectUploadHandler);

router.get('/upload-status/:sessionId', verifyFirebaseToken, getUploadStatusHandler);

router.post('/webhook', (req, res, next) => {
  if (Buffer.isBuffer(req.body)) {
    const rawBody = req.body.toString('utf8');
    (req as typeof req & { rawBody?: string }).rawBody = rawBody;
    try {
      req.body = JSON.parse(rawBody);
    } catch {
      res.status(400).json({ success: false, error: 'Invalid JSON' });
      return;
    }
  }
  void handleStreamWebhook(req, res).catch(next);
});

export default router;
