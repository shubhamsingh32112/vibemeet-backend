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
  deactivateCreator,
  reactivateCreator,
  refundCall,
  getRefundPreview,
  getSettlementRetryPreview,
  retryCallSettlement,
  retryCallSettlementBulk,
  getAdminActionLog,
  getWithdrawals,
  approveWithdrawal,
  rejectWithdrawal,
  markWithdrawalPaid,
  getSupportTickets,
  exportSupportTicketsCsv,
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
  listMomentPurchasesHandler,
  regrantMomentPurchaseHandler,
  refundMomentPurchaseHandler,
} from './admin-moment-purchase.controller';
import {
  approveMomentModerationHandler,
  escalateMomentModerationHandler,
  listEscalatedMomentsModerationHandler,
  listPendingMomentsModerationHandler,
  rejectMomentModerationHandler,
} from './admin-moment-moderation.controller';
import {
  getMomentsAdminConfigHandler,
  listFreePreviewsHandler,
  reorderFreePreviewsHandler,
  addFreePreviewHandler,
  removeFreePreviewHandler,
  patchFreePreviewHandler,
  browseMomentsForAdminHandler,
  patchMomentVisibilityTierHandler,
} from './admin-moments-free-preview.controller';
import {
  getAdminVipPlan,
  getAdminVipStats,
  grantAdminVipMembership,
  listAdminVipMembers,
  listAdminVipPlans,
  revokeAdminVipMembership,
  updateAdminVipPlan,
  updateAdminVipPlanById,
} from '../vip/admin-vip.controller';
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
import {
  getCachedLeaderboardHosts,
  getFinancePayments,
  getFinancePayoutsSummary,
  getFinanceSettlements,
  getMomentsPaidUsers,
  getMomentsPremiumUsers,
  getRevenueAnalyticsSummary,
  getUsersSummary,
  getUsersLoginSeries,
  getUsersSignupSeries,
  getCoinsPaidUsers,
  getVipPaidUsers,
  getWalletTransactions,
} from './admin-analytics.controller';

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
router.get('/leaderboards/hosts/cached', getCachedLeaderboardHosts);
router.get('/leaderboards/users', getLeaderboardUsers);
router.get('/analytics/users/summary', getUsersSummary);
router.get('/analytics/users/login-series', getUsersLoginSeries);
router.get('/analytics/users/signup-series', getUsersSignupSeries);
router.get('/analytics/coins/paid-users', getCoinsPaidUsers);
router.get('/analytics/moments/paid-users', getMomentsPaidUsers);
router.get('/analytics/moments/premium-users', getMomentsPremiumUsers);
router.get('/analytics/vip/paid-users', getVipPaidUsers);
router.get('/analytics/revenue/summary', getRevenueAnalyticsSummary);
router.get('/wallet/transactions', getWalletTransactions);
router.get('/finance/payments', getFinancePayments);
router.get('/finance/payouts/summary', getFinancePayoutsSummary);
router.get('/finance/settlements', getFinanceSettlements);
router.get('/users/:id/ledger', getUserLedger);
router.get('/coins', getCoinEconomy);
router.get('/wallet-pricing', getWalletPricing);
router.get('/platform-revenue', getPlatformRevenueConfigAdmin);
router.put('/platform-revenue', updatePlatformRevenueConfigAdmin);
router.get('/calls', getCallsAdmin);
router.get('/calls/:callId/refund-preview', getRefundPreview);
router.get('/calls/:callId/settlement-retry-preview', getSettlementRetryPreview);
router.post('/calls/retry-settlement-bulk', retryCallSettlementBulk);
router.post('/calls/:callId/retry-settlement', retryCallSettlement);
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
router.get('/support/export.csv', exportSupportTicketsCsv);
router.get('/support', getSupportTickets);
router.patch('/support/:id/status', updateTicketStatus);
router.patch('/support/:id/assign', assignTicket);

// ── Admin Actions ───────────────────────────────────────────────────────
router.post('/users/:id/adjust-coins', adjustUserCoins);
router.post('/creators/:id/reset-presence', resetCreatorPresence);
router.post('/creators/:id/deactivate', deactivateCreator);
router.post('/creators/:id/reactivate', reactivateCreator);
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

router.get('/moments/purchases', listMomentPurchasesHandler);
router.post('/moments/purchases/regrant', regrantMomentPurchaseHandler);
router.post('/moments/purchases/refund', refundMomentPurchaseHandler);

router.get('/moments/moderation/pending', listPendingMomentsModerationHandler);
router.get('/moments/moderation/escalated', listEscalatedMomentsModerationHandler);
router.post('/moments/moderation/approve', approveMomentModerationHandler);
router.post('/moments/moderation/reject', rejectMomentModerationHandler);
router.post('/moments/moderation/escalate', escalateMomentModerationHandler);

router.get('/moments/config', getMomentsAdminConfigHandler);
router.get('/moments/free-previews', listFreePreviewsHandler);
router.put('/moments/free-previews/reorder', reorderFreePreviewsHandler);
router.post('/moments/free-previews', addFreePreviewHandler);
router.delete('/moments/free-previews/:momentId', removeFreePreviewHandler);
router.patch('/moments/free-previews/:momentId', patchFreePreviewHandler);
router.get('/moments/browse', browseMomentsForAdminHandler);
router.patch('/moments/:momentId/visibility-tier', patchMomentVisibilityTierHandler);

router.get('/vip/plan', getAdminVipPlan);
router.get('/vip/plans', listAdminVipPlans);
router.put('/vip/plan', updateAdminVipPlan);
router.put('/vip/plans/:planId', updateAdminVipPlanById);
router.get('/vip/members', listAdminVipMembers);
router.get('/vip/stats', getAdminVipStats);
router.post('/vip/members/:id/grant', grantAdminVipMembership);
router.post('/vip/members/:id/revoke', revokeAdminVipMembership);

export default router;
