import { Router } from 'express';
import { verifyFirebaseToken } from '../../middlewares/auth.middleware';
import {
  getAgencyDashboardSummary,
  changeAgencyPassword,
  patchAgencyProfile,
  getAgencyReferredUsers,
  getAgencyCreators,
  getAgencyCreatorDetail,
  getAgencyWithdrawals,
  agencyApproveWithdrawal,
  agencyRejectWithdrawal,
  agencyMarkWithdrawalPaid,
  approveAgencyReferredUser,
  rejectAgencyReferredUser,
  postAgencyStaffWithdrawalRequest,
} from './agency-portal.controller';
import {
  getAgencyWallet,
  getAgencyWalletTransactions,
  getAgencyWalletWithdrawals,
  postAgencyWalletWithdrawal,
  putAgencyWalletPayoutAccount,
} from '../billing/staff-wallet-portal.controller';

const router = Router();
router.use(verifyFirebaseToken);

router.get('/summary', getAgencyDashboardSummary);
router.post('/change-password', changeAgencyPassword);
router.patch('/profile', patchAgencyProfile);
router.get('/wallet', getAgencyWallet);
router.get('/wallet/transactions', getAgencyWalletTransactions);
router.get('/wallet/withdrawals', getAgencyWalletWithdrawals);
router.put('/wallet/payout-account', putAgencyWalletPayoutAccount);
router.post('/wallet/withdrawals', postAgencyWalletWithdrawal);
router.get('/referred-users', getAgencyReferredUsers);
router.post('/referred-users/:userId/approve', approveAgencyReferredUser);
router.post('/referred-users/:userId/reject', rejectAgencyReferredUser);
router.get('/creators', getAgencyCreators);
router.get('/creators/:creatorId', getAgencyCreatorDetail);
router.get('/withdrawals', getAgencyWithdrawals);
router.post('/staff-withdrawals', postAgencyStaffWithdrawalRequest);
router.post('/withdrawals/:id/approve', agencyApproveWithdrawal);
router.post('/withdrawals/:id/reject', agencyRejectWithdrawal);
router.post('/withdrawals/:id/mark-paid', agencyMarkWithdrawalPaid);

export default router;
