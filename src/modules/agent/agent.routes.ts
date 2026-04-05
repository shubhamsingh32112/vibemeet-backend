import { Router } from 'express';
import { verifyFirebaseToken } from '../../middlewares/auth.middleware';
import {
  getAgentDashboardSummary,
  getPendingApplications,
  acceptApplication,
  rejectApplication,
  getAgentCreators,
  getAgentCreatorDetail,
  postAgentCreateCreator,
  searchUsersForAgent,
  getAgentWithdrawals,
  agentApproveWithdrawal,
  agentRejectWithdrawal,
  agentMarkWithdrawalPaid,
} from './agent.controller';

const router = Router();
router.use(verifyFirebaseToken);

router.get('/summary', getAgentDashboardSummary);
router.get('/pending-applications', getPendingApplications);
router.post('/applications/:id/accept', acceptApplication);
router.post('/applications/:id/reject', rejectApplication);
router.get('/search-users', searchUsersForAgent);
router.post('/creators', postAgentCreateCreator);
router.get('/creators', getAgentCreators);
router.get('/creators/:creatorId', getAgentCreatorDetail);
router.get('/withdrawals', getAgentWithdrawals);
router.post('/withdrawals/:id/approve', agentApproveWithdrawal);
router.post('/withdrawals/:id/reject', agentRejectWithdrawal);
router.post('/withdrawals/:id/mark-paid', agentMarkWithdrawalPaid);

export default router;
