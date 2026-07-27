import { Router } from 'express';
import { verifyFirebaseToken } from '../../middlewares/auth.middleware';
import {
  withdrawalLimiter,
  tasksLimiter,
} from '../../middlewares/rate-limit.middleware';
import { blockIfHostDisabled } from './creator-disabled.guard';
import {
  getCreatorCatalogGone,
  getPublicCreatorFeed,
  getPublicCreatorById,
  getCreatorFeed,
  getCreatorFirebaseUids,
  getCreatorByFirebaseUid,
  getCreatorById,
  createCreator,
  updateCreator,
  deleteCreator,
  setCreatorOnlineStatus,
  updateMyCreatorProfile,
  getMyCreatorProfile,
  commitGalleryImage,
  deleteGalleryImage,
  reorderGalleryImages,
  getCreatorEarnings,
  getCreatorTransactions,
  getCreatorTasks,
  claimTaskReward,
  getCreatorDashboard,
  requestWithdrawal,
  getMyWithdrawals,
} from './creator.controller';
import {
  getCreatorLeaderboardHandler,
  getCreatorLeaderboardSummaryHandler,
} from './creator-leaderboard.controller';

const router = Router();
const hostTools = [verifyFirebaseToken, blockIfHostDisabled] as const;

// Routes that require authentication to check user role
router.get('/', verifyFirebaseToken, getCreatorCatalogGone);
// IMPORTANT: Specific routes must come before parameterized routes
router.get('/public/feed', getPublicCreatorFeed);
router.get('/public/:id', getPublicCreatorById);
router.get('/feed', verifyFirebaseToken, getCreatorFeed);
router.get('/uids', verifyFirebaseToken, getCreatorFirebaseUids);
router.get('/by-firebase-uid/:uid', verifyFirebaseToken, getCreatorByFirebaseUid);
router.get('/dashboard', ...hostTools, getCreatorDashboard); // Consolidated creator dashboard (cached)
router.get('/leaderboard/summary', verifyFirebaseToken, getCreatorLeaderboardSummaryHandler);
router.get('/leaderboard', verifyFirebaseToken, getCreatorLeaderboardHandler);
router.get('/earnings', ...hostTools, getCreatorEarnings); // Get creator earnings summary
router.get('/transactions', ...hostTools, getCreatorTransactions); // Get creator transaction history
router.get('/tasks', ...hostTools, tasksLimiter, getCreatorTasks); // Get creator tasks progress (rate limited)
router.post('/tasks/:taskKey/claim', ...hostTools, claimTaskReward); // Claim task reward
router.post('/withdraw', ...hostTools, withdrawalLimiter, requestWithdrawal); // Request withdrawal (rate limited)
router.get('/withdrawals', ...hostTools, getMyWithdrawals); // Get my withdrawal history
// Profile GET stays open so clients can detect isDisabled and show the lock screen
router.get('/profile', verifyFirebaseToken, getMyCreatorProfile);
router.post('/profile/gallery/commit', ...hostTools, commitGalleryImage);
router.delete('/profile/gallery/:imageId', ...hostTools, deleteGalleryImage);
router.patch('/profile/gallery/reorder', ...hostTools, reorderGalleryImages);
router.get('/:id', verifyFirebaseToken, getCreatorById);

// Protected routes (require authentication)
router.post('/', verifyFirebaseToken, createCreator);
router.put('/:id', ...hostTools, updateCreator);
router.delete('/:id', ...hostTools, deleteCreator);
router.patch('/status', ...hostTools, setCreatorOnlineStatus); // Set creator online/offline status
router.patch('/profile', ...hostTools, updateMyCreatorProfile); // Update creator's own profile

export default router;
