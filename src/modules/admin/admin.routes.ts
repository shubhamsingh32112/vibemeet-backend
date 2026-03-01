import { Router } from 'express';
import { verifyFirebaseToken } from '../../middlewares/auth.middleware';
import {
  getOverview,
  getCreatorsPerformance,
  getUsersAnalytics,
  getUserLedger,
  getCoinEconomy,
  getWalletPricing,
  getCallsAdmin,
  getSystemHealth,
  adjustUserCoins,
  forceCreatorOffline,
  refundCall,
  getRefundPreview,
  getAdminActionLog,
  getWithdrawals,
  approveWithdrawal,
  rejectWithdrawal,
  markWithdrawalPaid,
  getSupportTickets,
  updateTicketStatus,
  assignTicket,
  getRealtimeMetrics,
  getIntegrityChecks,
  getSecurityFlags,
  getFullAuditReport,
  updateWalletPricing,
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
router.get('/wallet-pricing', getWalletPricing);
router.get('/calls', getCallsAdmin);
router.get('/calls/:callId/refund-preview', getRefundPreview);
router.get('/system/health', getSystemHealth);
router.get('/realtime-metrics', getRealtimeMetrics);
router.get('/actions/log', getAdminActionLog);

// ── Withdrawal Management ────────────────────────────────────────────────
router.get('/withdrawals', getWithdrawals);
router.post('/withdrawals/:id/approve', approveWithdrawal);
router.post('/withdrawals/:id/reject', rejectWithdrawal);
router.post('/withdrawals/:id/mark-paid', markWithdrawalPaid);

// ── Support Ticket Management ────────────────────────────────────────────
router.get('/support', getSupportTickets);
router.patch('/support/:id/status', updateTicketStatus);
router.patch('/support/:id/assign', assignTicket);

// ── Admin Actions ───────────────────────────────────────────────────────
router.post('/users/:id/adjust-coins', adjustUserCoins);
router.post('/creators/:id/force-offline', forceCreatorOffline);
router.post('/calls/:callId/refund', refundCall);
router.put('/wallet-pricing', updateWalletPricing);

// ── Phase 7: Data Integrity Checks ─────────────────────────────────────
router.get('/integrity-checks', getIntegrityChecks);

// ── Phase 9: Security & Abuse Controls ─────────────────────────────────
router.get('/creators/security-flags', getSecurityFlags);

// ── Phase 10: Full Audit Report ────────────────────────────────────────
router.get('/full-audit-report', getFullAuditReport);

export default router;
