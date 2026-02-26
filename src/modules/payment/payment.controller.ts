import type { Request, Response } from 'express';
import { paymentApplicationService } from './payment.application.service';

export const createOrder = async (req: Request, res: Response): Promise<void> =>
  paymentApplicationService.createOrder(req, res);
export const verifyPayment = async (req: Request, res: Response): Promise<void> =>
  paymentApplicationService.verifyPayment(req, res);
export const getWalletPackages = async (req: Request, res: Response): Promise<void> =>
  paymentApplicationService.getWalletPackages(req, res);
export const initiateWebCheckout = async (req: Request, res: Response): Promise<void> =>
  paymentApplicationService.initiateWebCheckout(req, res);
export const createWebOrder = async (req: Request, res: Response): Promise<void> =>
  paymentApplicationService.createWebOrder(req, res);
export const verifyWebPayment = async (req: Request, res: Response): Promise<void> =>
  paymentApplicationService.verifyWebPayment(req, res);

