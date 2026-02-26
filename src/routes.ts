import { Router } from 'express';
import authRoutes from './modules/auth/auth.routes';
import userRoutes from './modules/user/user.routes';
import creatorRoutes from './modules/creator/creator.routes';
import chatRoutes from './modules/chat/chat.routes';
import videoRoutes from './modules/video/video.routes';
import adminRoutes from './modules/admin/admin.routes';
import billingRoutes from './modules/billing/billing.routes';
import supportRoutes from './modules/support/support.routes';
import paymentRoutes from './modules/payment/payment.routes';

const router = Router();

router.use('/auth', authRoutes);
router.use('/user', userRoutes);
router.use('/creator', creatorRoutes);
router.use('/chat', chatRoutes);
router.use('/video', videoRoutes);
router.use('/admin', adminRoutes);
router.use('/billing', billingRoutes);
router.use('/support', supportRoutes);
router.use('/payment', paymentRoutes);

export default router;
