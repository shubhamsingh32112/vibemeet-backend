import type { Request, Response } from 'express';
import { featureFlags } from '../../config/feature-flags';
import { AdminRepository } from './admin.repository';
import * as legacy from './admin.legacy.controller';

export class AdminApplicationService {
  constructor(private readonly adminRepository: AdminRepository = new AdminRepository()) {}

  async getOverview(req: Request, res: Response): Promise<void> {
    return this.delegate(req, res, legacy.getOverview);
  }
  async getCreatorsPerformance(req: Request, res: Response): Promise<void> {
    return this.delegate(req, res, legacy.getCreatorsPerformance);
  }
  async getUsersAnalytics(req: Request, res: Response): Promise<void> {
    return this.delegate(req, res, legacy.getUsersAnalytics);
  }
  async getUserLedger(req: Request, res: Response): Promise<void> {
    return this.delegate(req, res, legacy.getUserLedger);
  }
  async getCoinEconomy(req: Request, res: Response): Promise<void> {
    return this.delegate(req, res, legacy.getCoinEconomy);
  }
  async getWalletPricing(req: Request, res: Response): Promise<void> {
    return this.delegate(req, res, legacy.getWalletPricing);
  }
  async updateWalletPricing(req: Request, res: Response): Promise<void> {
    return this.delegate(req, res, legacy.updateWalletPricing);
  }
  async getCallsAdmin(req: Request, res: Response): Promise<void> {
    return this.delegate(req, res, legacy.getCallsAdmin);
  }
  async getSystemHealth(req: Request, res: Response): Promise<void> {
    return this.delegate(req, res, legacy.getSystemHealth);
  }
  async getSourceOfTruthDrift(req: Request, res: Response): Promise<void> {
    return this.delegate(req, res, legacy.getSourceOfTruthDrift);
  }
  async adjustUserCoins(req: Request, res: Response): Promise<void> {
    return this.delegate(req, res, legacy.adjustUserCoins);
  }
  async forceCreatorOffline(req: Request, res: Response): Promise<void> {
    return this.delegate(req, res, legacy.forceCreatorOffline);
  }
  async refundCall(req: Request, res: Response): Promise<void> {
    return this.delegate(req, res, legacy.refundCall);
  }
  async getRefundPreview(req: Request, res: Response): Promise<void> {
    return this.delegate(req, res, legacy.getRefundPreview);
  }
  async getAdminActionLog(req: Request, res: Response): Promise<void> {
    return this.delegate(req, res, legacy.getAdminActionLog);
  }
  async getWithdrawals(req: Request, res: Response): Promise<void> {
    return this.delegate(req, res, legacy.getWithdrawals);
  }
  async approveWithdrawal(req: Request, res: Response): Promise<void> {
    return this.delegate(req, res, legacy.approveWithdrawal);
  }
  async rejectWithdrawal(req: Request, res: Response): Promise<void> {
    return this.delegate(req, res, legacy.rejectWithdrawal);
  }
  async markWithdrawalPaid(req: Request, res: Response): Promise<void> {
    return this.delegate(req, res, legacy.markWithdrawalPaid);
  }
  async getSupportTickets(req: Request, res: Response): Promise<void> {
    return this.delegate(req, res, legacy.getSupportTickets);
  }
  async updateTicketStatus(req: Request, res: Response): Promise<void> {
    return this.delegate(req, res, legacy.updateTicketStatus);
  }
  async assignTicket(req: Request, res: Response): Promise<void> {
    return this.delegate(req, res, legacy.assignTicket);
  }
  async getRealtimeMetrics(req: Request, res: Response): Promise<void> {
    return this.delegate(req, res, legacy.getRealtimeMetrics);
  }
  async getIntegrityChecks(req: Request, res: Response): Promise<void> {
    return this.delegate(req, res, legacy.getIntegrityChecks);
  }
  async getSecurityFlags(req: Request, res: Response): Promise<void> {
    return this.delegate(req, res, legacy.getSecurityFlags);
  }
  async getFullAuditReport(req: Request, res: Response): Promise<void> {
    return this.delegate(req, res, legacy.getFullAuditReport);
  }

  shouldUseUsersAnalyticsCache(params: { query?: string; role?: string; sort?: string }): boolean {
    const hasQuery = Boolean(params.query && params.query.trim());
    const hasRoleFilter = Boolean(params.role && params.role !== 'all');
    const hasSort = Boolean(params.sort);
    return !(hasQuery || hasRoleFilter || hasSort);
  }

  private async delegate(
    req: Request,
    res: Response,
    legacyHandler: (req: Request, res: Response) => Promise<void>
  ): Promise<void> {
    // Phase 5 strangler: keep legacy path as source of truth until feature flag cutover.
    if (!featureFlags.adminControllerServiceCutover) {
      return legacyHandler(req, res);
    }

    if (req.auth?.firebaseUid) {
      await this.adminRepository.findUserByFirebaseUid(req.auth.firebaseUid);
    }

    return legacyHandler(req, res);
  }
}

export const adminApplicationService = new AdminApplicationService();

