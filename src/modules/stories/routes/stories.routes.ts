import { Router } from 'express';
import { verifyFirebaseToken } from '../../../middlewares/auth.middleware';
import {
  createStoryHandler,
  getStoriesFeedHandler,
  getCreatorStoriesHandler,
  getMyStoriesHandler,
  deleteStoryHandler,
  recordStoryViewHandler,
  getStoryViewersHandler,
  refreshStoryPlaybackHandler,
  completeStoryHandler,
} from '../controllers/stories.controller';

const router = Router();

router.post('/', verifyFirebaseToken, createStoryHandler);
router.get('/feed', verifyFirebaseToken, getStoriesFeedHandler);
router.get('/creator/me', verifyFirebaseToken, getMyStoriesHandler);
router.get('/creator/:creatorId', verifyFirebaseToken, getCreatorStoriesHandler);
router.delete('/:storyId', verifyFirebaseToken, deleteStoryHandler);
router.post('/:storyId/view', verifyFirebaseToken, recordStoryViewHandler);
router.post('/:storyId/playback', verifyFirebaseToken, refreshStoryPlaybackHandler);
router.post('/:storyId/complete', verifyFirebaseToken, completeStoryHandler);
router.get('/:storyId/viewers', verifyFirebaseToken, getStoryViewersHandler);

export default router;
