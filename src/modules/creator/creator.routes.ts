import { Router } from 'express';
import { verifyFirebaseToken } from '../../middlewares/auth.middleware';
import {
  withdrawalLimiter,
  tasksLimiter,
  creatorGalleryUploadLimiter,
} from '../../middlewares/rate-limit.middleware';
import {
  getCreatorCatalogGone,
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
  createGalleryUploadUrl,
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

const router = Router();

// Routes that require authentication to check user role
router.get('/', verifyFirebaseToken, getCreatorCatalogGone);
// IMPORTANT: Specific routes must come before parameterized routes
router.get('/feed', verifyFirebaseToken, getCreatorFeed);
router.get('/uids', verifyFirebaseToken, getCreatorFirebaseUids);
router.get('/by-firebase-uid/:uid', verifyFirebaseToken, getCreatorByFirebaseUid);
router.get('/dashboard', verifyFirebaseToken, getCreatorDashboard); // Consolidated creator dashboard (cached)
router.get('/earnings', verifyFirebaseToken, getCreatorEarnings); // Get creator earnings summary
router.get('/transactions', verifyFirebaseToken, getCreatorTransactions); // Get creator transaction history
router.get('/tasks', verifyFirebaseToken, tasksLimiter, getCreatorTasks); // Get creator tasks progress (rate limited)
router.post('/tasks/:taskKey/claim', verifyFirebaseToken, claimTaskReward); // Claim task reward
router.post('/withdraw', verifyFirebaseToken, withdrawalLimiter, requestWithdrawal); // Request withdrawal (rate limited)
router.get('/withdrawals', verifyFirebaseToken, getMyWithdrawals); // Get my withdrawal history
router.get('/profile', verifyFirebaseToken, getMyCreatorProfile); // Get creator's own profile
router.post(
  '/profile/gallery/upload-url',
  verifyFirebaseToken,
  creatorGalleryUploadLimiter,
  createGalleryUploadUrl,
);
router.post('/profile/gallery/commit', verifyFirebaseToken, commitGalleryImage);
router.delete('/profile/gallery/:imageId', verifyFirebaseToken, deleteGalleryImage);
router.patch('/profile/gallery/reorder', verifyFirebaseToken, reorderGalleryImages);
router.get('/:id', verifyFirebaseToken, getCreatorById);

// Protected routes (require authentication)
router.post('/', verifyFirebaseToken, createCreator);
router.put('/:id', verifyFirebaseToken, updateCreator);
router.delete('/:id', verifyFirebaseToken, deleteCreator);
router.patch('/status', verifyFirebaseToken, setCreatorOnlineStatus); // Set creator online/offline status
router.patch('/profile', verifyFirebaseToken, updateMyCreatorProfile); // Update creator's own profile

export default router;
