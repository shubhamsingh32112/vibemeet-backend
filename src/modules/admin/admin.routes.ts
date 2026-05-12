import { Router } from 'express';
import { verifyFirebaseToken } from '../../middlewares/auth.middleware';
import {
  appUpdatePublishLimiter,
} from '../../middlewares/rate-limit.middleware';
import {
  createAgent,
  listAgents,
  listAgentsBrief,
  getAgentDetail,
  patchAgent,
} from './admin-agent.controller';
import {
  createAgency,
  listAgencies,
  getAgencyDetail,
  patchAgency,
} from './admin-agency.controller';
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
  getPlatformRevenueConfigAdmin,
  updatePlatformRevenueConfigAdmin,
  patchCreatorLinkedUser,
  postAdminTransferCreatorToAgent,
  adminCreatorGalleryCommit,
  adminCreatorGalleryDelete,
  adminCreatorGalleryReorder,
} from './admin.controller';
import {
  getCurrentGlobalAppUpdateForAdmin,
  publishGlobalAppUpdate,
} from '../app-update/app-update.controller';
import {
  listPendingImages,
  approveImage,
  rejectImage,
  getImagePipelineHealth,
} from './admin-image-moderation.controller';
import {
  getStaffWalletReconciliationLogs,
  postStaffWalletReconciliationRun,
} from '../billing/staff-wallet-reconciliation.controller';
import { getAuditEvents } from '../audit/audit-event.controller';
import { postReplayDomainEvent } from '../events/domain-event.controller';
import { postAdminAnalyticsRebuild } from '../analytics/analytics.controller';
import {
  getFraudSignals,
  getFraudInvestigations,
  postFraudInvestigationNote,
  postFraudRulesRun,
} from '../fraud/fraud.controller';

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
router.get('/platform-revenue', getPlatformRevenueConfigAdmin);
router.put('/platform-revenue', updatePlatformRevenueConfigAdmin);
router.get('/calls', getCallsAdmin);
router.get('/calls/:callId/refund-preview', getRefundPreview);
router.get('/system/health', getSystemHealth);
router.get('/app-updates/current', getCurrentGlobalAppUpdateForAdmin);
router.get('/realtime-metrics', getRealtimeMetrics);
router.get('/actions/log', getAdminActionLog);
router.get('/audit-events', getAuditEvents);

// ── Agencies (super-admin) ───────────────────────────────────────────────
router.post('/agencies', createAgency);
router.get('/agencies', listAgencies);
router.get('/agencies/:id', getAgencyDetail);
router.patch('/agencies/:id', patchAgency);

// ── BD / agents (super-admin) ─────────────────────────────────────────────
router.post('/agents', createAgent);
router.get('/agents/brief', listAgentsBrief);
router.get('/agents', listAgents);
router.get('/agents/:id', getAgentDetail);
router.patch('/agents/:id', patchAgent);

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
router.patch('/creators/:id/user', patchCreatorLinkedUser);
router.post('/creators/:id/transfer-agent', postAdminTransferCreatorToAgent);
router.post('/creators/:id/gallery/commit', adminCreatorGalleryCommit);
router.delete('/creators/:id/gallery/:imageId', adminCreatorGalleryDelete);
router.patch('/creators/:id/gallery/reorder', adminCreatorGalleryReorder);
router.post('/calls/:callId/refund', refundCall);
router.put('/wallet-pricing', updateWalletPricing);
router.post('/app-updates/publish', appUpdatePublishLimiter, publishGlobalAppUpdate);

// ── Phase 7: Data Integrity Checks ─────────────────────────────────────
router.get('/integrity-checks', getIntegrityChecks);

// ── Staff wallet reconciliation (ledger vs cached balance) ────────────
router.get('/staff-wallet-reconciliation', getStaffWalletReconciliationLogs);
router.post('/staff-wallet-reconciliation/run', postStaffWalletReconciliationRun);
router.post('/domain-events/:eventId/replay', postReplayDomainEvent);
router.post('/analytics/rebuild', postAdminAnalyticsRebuild);

router.get('/fraud/signals', getFraudSignals);
router.get('/fraud/investigations', getFraudInvestigations);
router.post('/fraud/investigations/:id/notes', postFraudInvestigationNote);
router.post('/fraud/rules/run', postFraudRulesRun);

// ── Phase 9: Security & Abuse Controls ─────────────────────────────────
router.get('/creators/security-flags', getSecurityFlags);

// ── Phase 10: Full Audit Report ────────────────────────────────────────
router.get('/full-audit-report', getFullAuditReport);

// ── Image moderation (Cloudflare-Images) ────────────────────────────────
router.get('/images/pending', listPendingImages);
router.post('/images/approve', approveImage);
router.post('/images/reject', rejectImage);
router.get('/images/health', getImagePipelineHealth);

export default router;
