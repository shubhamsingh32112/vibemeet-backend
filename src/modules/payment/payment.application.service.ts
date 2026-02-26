import type { Request, Response } from 'express';
import { featureFlags } from '../../config/feature-flags';
import { PaymentRepository } from './payment.repository';
import * as legacy from './payment.legacy.controller';

export class PaymentApplicationService {
  constructor(private readonly paymentRepository: PaymentRepository = new PaymentRepository()) {}

  async createOrder(req: Request, res: Response): Promise<void> {
    return this.delegate(req, res, legacy.createOrder);
  }
  async verifyPayment(req: Request, res: Response): Promise<void> {
    return this.delegate(req, res, legacy.verifyPayment);
  }
  async getWalletPackages(req: Request, res: Response): Promise<void> {
    return this.delegate(req, res, legacy.getWalletPackages);
  }
  async initiateWebCheckout(req: Request, res: Response): Promise<void> {
    return this.delegate(req, res, legacy.initiateWebCheckout);
  }
  async createWebOrder(req: Request, res: Response): Promise<void> {
    return this.delegate(req, res, legacy.createWebOrder);
  }
  async verifyWebPayment(req: Request, res: Response): Promise<void> {
    return this.delegate(req, res, legacy.verifyWebPayment);
  }

  validateCreateOrderCoins(coins: unknown): boolean {
    return typeof coins === 'number' && coins > 0;
  }

  buildInvalidPackageMessage(validCoins: number[]): string {
    return `Invalid coin package. Valid packages: ${validCoins.join(', ')}`;
  }

  private async delegate(
    req: Request,
    res: Response,
    legacyHandler: (req: Request, res: Response) => Promise<void>
  ): Promise<void> {
    if (!featureFlags.paymentControllerServiceCutover) {
      return legacyHandler(req, res);
    }

    if (req.auth?.firebaseUid) {
      await this.paymentRepository.findUserByFirebaseUid(req.auth.firebaseUid);
    }

    return legacyHandler(req, res);
  }
}

export const paymentApplicationService = new PaymentApplicationService();

