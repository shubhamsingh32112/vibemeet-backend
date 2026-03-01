import { Router } from 'express';
import { verifyFirebaseToken } from '../../middlewares/auth.middleware';
import { withdrawalLimiter, tasksLimiter } from '../../middlewares/rate-limit.middleware';
import {
  getAllCreators,
  getCreatorById,
  createCreator,
  updateCreator,
  deleteCreator,
  setCreatorOnlineStatus,
  updateMyCreatorProfile,
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
router.get('/', verifyFirebaseToken, getAllCreators);
// IMPORTANT: Specific routes must come before parameterized routes
router.get('/dashboard', verifyFirebaseToken, getCreatorDashboard); // Consolidated creator dashboard (cached)
router.get('/earnings', verifyFirebaseToken, getCreatorEarnings); // Get creator earnings summary
router.get('/transactions', verifyFirebaseToken, getCreatorTransactions); // Get creator transaction history
router.get('/tasks', verifyFirebaseToken, tasksLimiter, getCreatorTasks); // Get creator tasks progress (rate limited)
router.post('/tasks/:taskKey/claim', verifyFirebaseToken, claimTaskReward); // Claim task reward
router.post('/withdraw', verifyFirebaseToken, withdrawalLimiter, requestWithdrawal); // Request withdrawal (rate limited)
router.get('/withdrawals', verifyFirebaseToken, getMyWithdrawals); // Get my withdrawal history
router.get('/:id', getCreatorById);

// Protected routes (require authentication)
router.post('/', verifyFirebaseToken, createCreator);
router.put('/:id', verifyFirebaseToken, updateCreator);
router.delete('/:id', verifyFirebaseToken, deleteCreator);
router.patch('/status', verifyFirebaseToken, setCreatorOnlineStatus); // Set creator online/offline status
router.patch('/profile', verifyFirebaseToken, updateMyCreatorProfile); // Update creator's own profile

export default router;
