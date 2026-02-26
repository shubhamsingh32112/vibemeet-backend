import type { Request, Response } from 'express';
import { adminApplicationService } from './admin.application.service';

export const getOverview = async (req: Request, res: Response): Promise<void> =>
  adminApplicationService.getOverview(req, res);
export const getCreatorsPerformance = async (req: Request, res: Response): Promise<void> =>
  adminApplicationService.getCreatorsPerformance(req, res);
export const getUsersAnalytics = async (req: Request, res: Response): Promise<void> =>
  adminApplicationService.getUsersAnalytics(req, res);
export const getUserLedger = async (req: Request, res: Response): Promise<void> =>
  adminApplicationService.getUserLedger(req, res);
export const getCoinEconomy = async (req: Request, res: Response): Promise<void> =>
  adminApplicationService.getCoinEconomy(req, res);
export const getWalletPricing = async (req: Request, res: Response): Promise<void> =>
  adminApplicationService.getWalletPricing(req, res);
export const updateWalletPricing = async (req: Request, res: Response): Promise<void> =>
  adminApplicationService.updateWalletPricing(req, res);
export const getCallsAdmin = async (req: Request, res: Response): Promise<void> =>
  adminApplicationService.getCallsAdmin(req, res);
export const getSystemHealth = async (req: Request, res: Response): Promise<void> =>
  adminApplicationService.getSystemHealth(req, res);
export const getSourceOfTruthDrift = async (req: Request, res: Response): Promise<void> =>
  adminApplicationService.getSourceOfTruthDrift(req, res);
export const adjustUserCoins = async (req: Request, res: Response): Promise<void> =>
  adminApplicationService.adjustUserCoins(req, res);
export const forceCreatorOffline = async (req: Request, res: Response): Promise<void> =>
  adminApplicationService.forceCreatorOffline(req, res);
export const refundCall = async (req: Request, res: Response): Promise<void> =>
  adminApplicationService.refundCall(req, res);
export const getRefundPreview = async (req: Request, res: Response): Promise<void> =>
  adminApplicationService.getRefundPreview(req, res);
export const getAdminActionLog = async (req: Request, res: Response): Promise<void> =>
  adminApplicationService.getAdminActionLog(req, res);
export const getWithdrawals = async (req: Request, res: Response): Promise<void> =>
  adminApplicationService.getWithdrawals(req, res);
export const approveWithdrawal = async (req: Request, res: Response): Promise<void> =>
  adminApplicationService.approveWithdrawal(req, res);
export const rejectWithdrawal = async (req: Request, res: Response): Promise<void> =>
  adminApplicationService.rejectWithdrawal(req, res);
export const markWithdrawalPaid = async (req: Request, res: Response): Promise<void> =>
  adminApplicationService.markWithdrawalPaid(req, res);
export const getSupportTickets = async (req: Request, res: Response): Promise<void> =>
  adminApplicationService.getSupportTickets(req, res);
export const updateTicketStatus = async (req: Request, res: Response): Promise<void> =>
  adminApplicationService.updateTicketStatus(req, res);
export const assignTicket = async (req: Request, res: Response): Promise<void> =>
  adminApplicationService.assignTicket(req, res);
export const getRealtimeMetrics = async (req: Request, res: Response): Promise<void> =>
  adminApplicationService.getRealtimeMetrics(req, res);
export const getIntegrityChecks = async (req: Request, res: Response): Promise<void> =>
  adminApplicationService.getIntegrityChecks(req, res);
export const getSecurityFlags = async (req: Request, res: Response): Promise<void> =>
  adminApplicationService.getSecurityFlags(req, res);
export const getFullAuditReport = async (req: Request, res: Response): Promise<void> =>
  adminApplicationService.getFullAuditReport(req, res);

