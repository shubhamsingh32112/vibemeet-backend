import { Router } from 'express';
import { verifyFirebaseToken } from '../../middlewares/auth.middleware';
import {
  getAgencySummary,
  getAgencyDashboard,
  listAgencyBds,
  createAgencyBd,
  postAgencyStaffWithdrawalRequest,
} from './agency-portal.controller';

const router = Router();
router.use(verifyFirebaseToken);

router.get('/summary', getAgencySummary);
router.get('/dashboard', getAgencyDashboard);
router.get('/bds', listAgencyBds);
router.post('/bds', createAgencyBd);
router.post('/staff-withdrawals', postAgencyStaffWithdrawalRequest);

export default router;
