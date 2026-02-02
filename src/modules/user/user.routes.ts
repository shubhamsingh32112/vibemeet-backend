import { Router } from 'express';
import { getMe, updateProfile, getAllUsers, searchUsers, promoteToCreator, addCoins, getUserTransactions, getFavoriteCreators, toggleFavoriteCreator } from './user.controller';
import { verifyFirebaseToken } from '../../middlewares/auth.middleware';

const router = Router();

router.get('/me', verifyFirebaseToken, getMe);
router.get('/list', verifyFirebaseToken, getAllUsers);
router.get('/search', verifyFirebaseToken, searchUsers); // Admin only - search users
router.put('/profile', verifyFirebaseToken, updateProfile);
router.post('/coins', verifyFirebaseToken, addCoins); // Add coins to user account
router.get('/transactions', verifyFirebaseToken, getUserTransactions); // Get user transaction history
router.get('/favorites', verifyFirebaseToken, getFavoriteCreators); // Get favorite creators (user only)
router.post('/favorites/:creatorId', verifyFirebaseToken, toggleFavoriteCreator); // Toggle favorite (user only)
router.post('/:id/promote-to-creator', verifyFirebaseToken, promoteToCreator); // Admin only - promote user to creator

export default router;
