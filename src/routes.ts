import { Router } from 'express';
import authRoutes from './modules/auth/auth.routes';
import userRoutes from './modules/user/user.routes';
import creatorRoutes from './modules/creator/creator.routes';
import chatRoutes from './modules/chat/chat.routes';
import videoRoutes from './modules/video/video.routes';
import adminRoutes from './modules/admin/admin.routes';

const router = Router();

router.use('/auth', authRoutes);
router.use('/user', userRoutes);
router.use('/creator', creatorRoutes);
router.use('/chat', chatRoutes);
router.use('/video', videoRoutes);
router.use('/admin', adminRoutes);

export default router;
