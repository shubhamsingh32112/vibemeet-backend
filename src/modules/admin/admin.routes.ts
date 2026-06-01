import { Router } from 'express';
import { verifyFirebaseToken } from '../../middlewares/auth.middleware';
import {
  appUpdatePublishLimiter,
} from '../../middlewares/rate-limit.middleware';
import {
  createAgency,
  listAgencies,
  listAgenciesBrief,
  getAgencyDetail,
  patchAgency,
} from './admin-agency.controller';
import {
  createBd,
  listBds,
  getBdDetail,
  patchBd,
  deleteBd,
} from './admin-bd.controller';
import {
  getDashboardAlerts,
  getDashboardCallAnalytics,
  getDashboardGeo,
  getDashboardHeatmap,
  getDashboardLiveCalls,
  getDashboardOverview,
  getDashboardPayouts,
  getDashboardRazorpayBalance,
  getDashboardRealtime,
  getDashboardRevenue,
  getDashboardTopAgencies,
  getDashboardTopBds,
  getDashboardTopHosts,
} from './admin-dashboard.controller';
import {
  getOverview,
  getCreatorsPerformance,
  getAdminCreatorDetail,
  getUsersAnalytics,
  getUserLedger,
  getCoinEconomy,
  getWalletPricing,
  getCallsAdmin,
  getSystemHealth,
  adjustUserCoins,
  resetCreatorPresence,
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
  postAdminTransferCreatorToAgency,
  adminCreatorAvatarCommit,
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
import { getBlockedHosts } from './admin-blocked-hosts.controller';
import { getRevenueSplitSummary } from './admin-revenue-split.controller';
import { getLeaderboardHosts, getLeaderboardUsers } from './admin-leaderboards.controller';

const router = Router();

// All admin routes require authentication (admin JWT handled by verifyFirebaseToken)
router.use(verifyFirebaseToken);

// ── Read-Only Endpoints ─────────────────────────────────────────────────
router.get('/overview', getOverview);
router.get('/creators/performance', getCreatorsPerformance);
router.get('/creators/:id/detail', getAdminCreatorDetail);
router.get('/users/analytics', getUsersAnalytics);
router.get('/blocked-hosts', getBlockedHosts);
router.get('/revenue-split/summary', getRevenueSplitSummary);
router.get('/leaderboards/hosts', getLeaderboardHosts);
router.get('/leaderboards/users', getLeaderboardUsers);
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

// ── Super Admin dashboard (BFF widgets) ───────────────────────────────────
router.get('/dashboard/overview', getDashboardOverview);
router.get('/dashboard/revenue', getDashboardRevenue);
router.get('/dashboard/live-calls', getDashboardLiveCalls);
router.get('/dashboard/realtime', getDashboardRealtime);
router.get('/dashboard/top-hosts', getDashboardTopHosts);
router.get('/dashboard/top-bds', getDashboardTopBds);
router.get('/dashboard/top-agencies', getDashboardTopAgencies);
router.get('/dashboard/alerts', getDashboardAlerts);
router.get('/dashboard/heatmap', getDashboardHeatmap);
router.get('/dashboard/call-analytics', getDashboardCallAnalytics);
router.get('/dashboard/payouts', getDashboardPayouts);
router.get('/dashboard/geo', getDashboardGeo);
router.get('/dashboard/razorpay-balance', getDashboardRazorpayBalance);

// ── Top-tier BDs (super-admin) ─────────────────────────────────────────────
router.post('/bds', createBd);
router.get('/bds', listBds);
router.get('/bds/:id', getBdDetail);
router.patch('/bds/:id', patchBd);
router.delete('/bds/:id', deleteBd);

// ── Middle-tier agencies (super-admin) ───────────────────────────────────
router.post('/agencies', createAgency);
router.get('/agencies/brief', listAgenciesBrief);
router.get('/agencies', listAgencies);
router.get('/agencies/:id', getAgencyDetail);
router.patch('/agencies/:id', patchAgency);

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
router.post('/creators/:id/reset-presence', resetCreatorPresence);
router.patch('/creators/:id/user', patchCreatorLinkedUser);
router.post('/creators/:id/transfer-agency', postAdminTransferCreatorToAgency);
router.post('/creators/:id/avatar/commit', adminCreatorAvatarCommit);
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
