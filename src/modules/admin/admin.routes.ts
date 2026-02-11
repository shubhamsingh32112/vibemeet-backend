import { Router } from 'express';
import { verifyFirebaseToken } from '../../middlewares/auth.middleware';
import {
  getOverview,
  getCreatorsPerformance,
  getUsersAnalytics,
  getUserLedger,
  getCoinEconomy,
  getCallsAdmin,
  getSystemHealth,
  adjustUserCoins,
  forceCreatorOffline,
  refundCall,
  getRefundPreview,
  getAdminActionLog,
} from './admin.controller';

const router = Router();

// All admin routes require authentication (admin JWT handled by verifyFirebaseToken)
router.use(verifyFirebaseToken);

// ── Read-Only Endpoints ─────────────────────────────────────────────────
router.get('/overview', getOverview);
router.get('/creators/performance', getCreatorsPerformance);
router.get('/users/analytics', getUsersAnalytics);
router.get('/users/:id/ledger', getUserLedger);
router.get('/coins', getCoinEconomy);
router.get('/calls', getCallsAdmin);
router.get('/calls/:callId/refund-preview', getRefundPreview);
router.get('/system/health', getSystemHealth);
router.get('/actions/log', getAdminActionLog);

// ── Admin Actions ───────────────────────────────────────────────────────
router.post('/users/:id/adjust-coins', adjustUserCoins);
router.post('/creators/:id/force-offline', forceCreatorOffline);
router.post('/calls/:callId/refund', refundCall);

export default router;
