import { Router } from 'express';
import { verifyFirebaseToken } from '../../middlewares/auth.middleware';
import {
  getAgentDashboardSummary,
  getAgentReferredUsers,
  getAgentCreators,
  getAgentCreatorDetail,
  postAgentCreateCreator,
  searchUsersForAgent,
  getAgentWithdrawals,
  agentApproveWithdrawal,
  agentRejectWithdrawal,
  agentMarkWithdrawalPaid,
  approveAgentReferredUser,
  rejectAgentReferredUser,
  postAgentStaffWithdrawalRequest,
} from './agent.controller';

const router = Router();
router.use(verifyFirebaseToken);

router.get('/summary', getAgentDashboardSummary);
router.get('/referred-users', getAgentReferredUsers);
router.post('/referred-users/:userId/approve', approveAgentReferredUser);
router.post('/referred-users/:userId/reject', rejectAgentReferredUser);
router.get('/search-users', searchUsersForAgent);
router.post('/creators', postAgentCreateCreator);
router.get('/creators', getAgentCreators);
router.get('/creators/:creatorId', getAgentCreatorDetail);
router.get('/withdrawals', getAgentWithdrawals);
router.post('/staff-withdrawals', postAgentStaffWithdrawalRequest);
router.post('/withdrawals/:id/approve', agentApproveWithdrawal);
router.post('/withdrawals/:id/reject', agentRejectWithdrawal);
router.post('/withdrawals/:id/mark-paid', agentMarkWithdrawalPaid);

export default router;
