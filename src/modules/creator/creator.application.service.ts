import type { Request, Response } from 'express';
import { featureFlags } from '../../config/feature-flags';
import { CreatorRepository } from './creator.repository';
import * as legacy from './creator.legacy.controller';

interface WithdrawalValidationResult {
  ok: boolean;
  error?: string;
}

export class CreatorApplicationService {
  constructor(private readonly creatorRepository: CreatorRepository = new CreatorRepository()) {}

  async getAllCreators(req: Request, res: Response): Promise<void> {
    return this.delegate(req, res, legacy.getAllCreators);
  }
  async getCreatorById(req: Request, res: Response): Promise<void> {
    return this.delegate(req, res, legacy.getCreatorById);
  }
  async createCreator(req: Request, res: Response): Promise<void> {
    return this.delegate(req, res, legacy.createCreator);
  }
  async updateCreator(req: Request, res: Response): Promise<void> {
    return this.delegate(req, res, legacy.updateCreator);
  }
  async deleteCreator(req: Request, res: Response): Promise<void> {
    return this.delegate(req, res, legacy.deleteCreator);
  }
  async setCreatorOnlineStatus(req: Request, res: Response): Promise<void> {
    return this.delegate(req, res, legacy.setCreatorOnlineStatus);
  }
  async getCreatorEarnings(req: Request, res: Response): Promise<void> {
    return this.delegate(req, res, legacy.getCreatorEarnings);
  }
  async getCreatorTransactions(req: Request, res: Response): Promise<void> {
    return this.delegate(req, res, legacy.getCreatorTransactions);
  }
  async getCreatorTasks(req: Request, res: Response): Promise<void> {
    return this.delegate(req, res, legacy.getCreatorTasks);
  }
  async claimTaskReward(req: Request, res: Response): Promise<void> {
    return this.delegate(req, res, legacy.claimTaskReward);
  }
  async getCreatorDashboard(req: Request, res: Response): Promise<void> {
    return this.delegate(req, res, legacy.getCreatorDashboard);
  }
  async requestWithdrawal(req: Request, res: Response): Promise<void> {
    return this.delegate(req, res, legacy.requestWithdrawal);
  }
  async getMyWithdrawals(req: Request, res: Response): Promise<void> {
    return this.delegate(req, res, legacy.getMyWithdrawals);
  }

  validateWithdrawalRequest(amount: unknown, currentBalance: number): WithdrawalValidationResult {
    if (typeof amount !== 'number' || amount <= 0) {
      return { ok: false, error: 'Amount must be a positive number' };
    }
    if (amount < 100) {
      return { ok: false, error: 'Minimum withdrawal amount is 100 coins' };
    }
    if (amount > currentBalance) {
      return {
        ok: false,
        error: `Insufficient balance. You have ${currentBalance} coins but requested ${amount}`,
      };
    }
    return { ok: true };
  }

  emitCreatorDataUpdated = legacy.emitCreatorDataUpdated;

  private async delegate(
    req: Request,
    res: Response,
    legacyHandler: (req: Request, res: Response) => Promise<void>
  ): Promise<void> {
    if (!featureFlags.creatorControllerServiceCutover) {
      return legacyHandler(req, res);
    }

    if (req.auth?.firebaseUid) {
      await this.creatorRepository.findUserByFirebaseUid(req.auth.firebaseUid);
    }

    return legacyHandler(req, res);
  }
}

export const creatorApplicationService = new CreatorApplicationService();

