import { Router } from 'express';
import { getMe, updateProfile, getAllUsers, searchUsers, promoteToCreator } from './user.controller';
import { verifyFirebaseToken } from '../../middlewares/auth.middleware';

const router = Router();

router.get('/me', verifyFirebaseToken, getMe);
router.get('/list', verifyFirebaseToken, getAllUsers);
router.get('/search', verifyFirebaseToken, searchUsers); // Admin only - search users
router.put('/profile', verifyFirebaseToken, updateProfile);
router.post('/:id/promote-to-creator', verifyFirebaseToken, promoteToCreator); // Admin only - promote user to creator

export default router;
