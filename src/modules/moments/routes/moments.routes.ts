import { Router } from 'express';
import { verifyFirebaseToken } from '../../../middlewares/auth.middleware';
import {
  createMomentHandler,
  getMomentsFeedHandler,
  getFollowingMomentsFeedHandler,
  getMomentDetailHandler,
  purchaseMomentHandler,
  deleteMomentHandler,
  getCreatorMomentsHandler,
  getCreatorAnalyticsHandler,
  followCreatorHandler,
  unfollowCreatorHandler,
  getFollowingListHandler,
  refreshPlaybackHandler,
  completeMomentHandler,
  getCreatorSummaryHandler,
  getMyMomentsHandler,
  recordMomentViewHandler,
  recordMomentsPaywallShownHandler,
} from '../controllers/moments.controller';

const router = Router();

router.post('/', verifyFirebaseToken, createMomentHandler);
router.get('/feed', verifyFirebaseToken, getMomentsFeedHandler);
router.get('/following', verifyFirebaseToken, getFollowingMomentsFeedHandler);
router.get('/creator/me/analytics', verifyFirebaseToken, getCreatorAnalyticsHandler);
router.get('/creator/me', verifyFirebaseToken, getMyMomentsHandler);
router.get('/creator/:creatorId', verifyFirebaseToken, getCreatorMomentsHandler);
router.get('/following/list', verifyFirebaseToken, getFollowingListHandler);
router.post('/analytics/paywall-shown', verifyFirebaseToken, recordMomentsPaywallShownHandler);
router.get('/creators/:creatorId/summary', verifyFirebaseToken, getCreatorSummaryHandler);
router.post('/creators/:creatorId/follow', verifyFirebaseToken, followCreatorHandler);
router.delete('/creators/:creatorId/follow', verifyFirebaseToken, unfollowCreatorHandler);
router.get('/:momentId', verifyFirebaseToken, getMomentDetailHandler);
router.post('/:momentId/view', verifyFirebaseToken, recordMomentViewHandler);
router.post('/:momentId/purchase', verifyFirebaseToken, purchaseMomentHandler);
router.post('/:momentId/playback', verifyFirebaseToken, refreshPlaybackHandler);
router.post('/:momentId/complete', verifyFirebaseToken, completeMomentHandler);
router.delete('/:momentId', verifyFirebaseToken, deleteMomentHandler);

export default router;
