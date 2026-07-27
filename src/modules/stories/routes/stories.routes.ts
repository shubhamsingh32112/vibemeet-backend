import { Router } from 'express';
import { verifyFirebaseToken } from '../../../middlewares/auth.middleware';
import { blockIfHostDisabled } from '../../creator/creator-disabled.guard';
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

router.post('/', verifyFirebaseToken, blockIfHostDisabled, createStoryHandler);
router.get('/feed', verifyFirebaseToken, getStoriesFeedHandler);
router.get('/creator/me', verifyFirebaseToken, blockIfHostDisabled, getMyStoriesHandler);
router.get('/creator/:creatorId', verifyFirebaseToken, getCreatorStoriesHandler);
router.delete('/:storyId', verifyFirebaseToken, blockIfHostDisabled, deleteStoryHandler);
router.post('/:storyId/view', verifyFirebaseToken, recordStoryViewHandler);
router.post('/:storyId/playback', verifyFirebaseToken, refreshStoryPlaybackHandler);
router.post('/:storyId/complete', verifyFirebaseToken, completeStoryHandler);
router.get('/:storyId/viewers', verifyFirebaseToken, getStoryViewersHandler);

export default router;
