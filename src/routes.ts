import { Router } from 'express';
import authRoutes from './modules/auth/auth.routes';
import userRoutes from './modules/user/user.routes';
import creatorRoutes from './modules/creator/creator.routes';
import callRoutes from './modules/call/call.routes';

const router = Router();

router.use('/auth', authRoutes);
router.use('/user', userRoutes);
router.use('/creator', creatorRoutes);
router.use('/calls', callRoutes);

export default router;
