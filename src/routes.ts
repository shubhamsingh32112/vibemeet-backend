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
import agentRoutes from './modules/agent/agent.routes';
import agencyRoutes from './modules/agency/agency.routes';
import referralRoutes from './modules/referral/referral.routes';
import appUpdateRoutes from './modules/app-update/app-update.routes';
import availabilityRoutes from './modules/availability/availability.routes';
import imagesRoutes from './modules/images/images.routes';
import metricsRoutes from './modules/metrics/metrics.routes';

const router = Router();

router.use('/auth', authRoutes);
router.use('/referral', referralRoutes);
router.use('/user', userRoutes);
router.use('/creator', creatorRoutes);
router.use('/chat', chatRoutes);
router.use('/video', videoRoutes);
router.use('/admin', adminRoutes);
router.use('/agent', agentRoutes);
router.use('/agency', agencyRoutes);
router.use('/billing', billingRoutes);
router.use('/support', supportRoutes);
router.use('/payment', paymentRoutes);
router.use('/app-updates', appUpdateRoutes);
router.use('/availability', availabilityRoutes);
router.use('/images', imagesRoutes);
router.use('/metrics', metricsRoutes);

export default router;
