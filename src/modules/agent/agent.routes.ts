import { Router } from 'express';
import { verifyFirebaseToken } from '../../middlewares/auth.middleware';
import {
  getAgentDashboardSummary,
  changeAgentPassword,
  patchAgentProfile,
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
import {
  getAgentWallet,
  getAgentWalletTransactions,
  getAgentWalletWithdrawals,
  postAgentWalletWithdrawal,
  putAgentWalletPayoutAccount,
} from '../billing/staff-wallet-portal.controller';

const router = Router();
router.use(verifyFirebaseToken);

router.get('/summary', getAgentDashboardSummary);
router.post('/change-password', changeAgentPassword);
router.patch('/profile', patchAgentProfile);
router.get('/wallet', getAgentWallet);
router.get('/wallet/transactions', getAgentWalletTransactions);
router.get('/wallet/withdrawals', getAgentWalletWithdrawals);
router.put('/wallet/payout-account', putAgentWalletPayoutAccount);
router.post('/wallet/withdrawals', postAgentWalletWithdrawal);
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
