import type { Request, Response } from 'express';
import { creatorApplicationService } from './creator.application.service';

export const getAllCreators = async (req: Request, res: Response): Promise<void> =>
  creatorApplicationService.getAllCreators(req, res);
export const getCreatorById = async (req: Request, res: Response): Promise<void> =>
  creatorApplicationService.getCreatorById(req, res);
export const createCreator = async (req: Request, res: Response): Promise<void> =>
  creatorApplicationService.createCreator(req, res);
export const updateCreator = async (req: Request, res: Response): Promise<void> =>
  creatorApplicationService.updateCreator(req, res);
export const deleteCreator = async (req: Request, res: Response): Promise<void> =>
  creatorApplicationService.deleteCreator(req, res);
export const setCreatorOnlineStatus = async (req: Request, res: Response): Promise<void> =>
  creatorApplicationService.setCreatorOnlineStatus(req, res);
export const getCreatorEarnings = async (req: Request, res: Response): Promise<void> =>
  creatorApplicationService.getCreatorEarnings(req, res);
export const getCreatorTransactions = async (req: Request, res: Response): Promise<void> =>
  creatorApplicationService.getCreatorTransactions(req, res);
export const getCreatorTasks = async (req: Request, res: Response): Promise<void> =>
  creatorApplicationService.getCreatorTasks(req, res);
export const claimTaskReward = async (req: Request, res: Response): Promise<void> =>
  creatorApplicationService.claimTaskReward(req, res);
export const getCreatorDashboard = async (req: Request, res: Response): Promise<void> =>
  creatorApplicationService.getCreatorDashboard(req, res);
export const requestWithdrawal = async (req: Request, res: Response): Promise<void> =>
  creatorApplicationService.requestWithdrawal(req, res);
export const getMyWithdrawals = async (req: Request, res: Response): Promise<void> =>
  creatorApplicationService.getMyWithdrawals(req, res);

export const emitCreatorDataUpdated = creatorApplicationService.emitCreatorDataUpdated;

