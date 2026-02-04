import { Router } from 'express';
import authRoutes from './modules/auth/auth.routes';
import userRoutes from './modules/user/user.routes';
import creatorRoutes from './modules/creator/creator.routes';
import chatRoutes from './modules/chat/chat.routes';
import videoRoutes from './modules/video/video.routes';

const router = Router();

router.use('/auth', authRoutes);
router.use('/user', userRoutes);
router.use('/creator', creatorRoutes);
router.use('/chat', chatRoutes);
router.use('/video', videoRoutes);

export default router;
