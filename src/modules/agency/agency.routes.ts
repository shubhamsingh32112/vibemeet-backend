import { Router } from 'express';
import { verifyFirebaseToken } from '../../middlewares/auth.middleware';
import {
  getAgencySummary,
  getAgencyDashboard,
  listAgencyBds,
  createAgencyBd,
  changeAgencyPassword,
  patchAgencyProfile,
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

router.get('/summary', getAgencySummary);
router.get('/dashboard', getAgencyDashboard);
router.get('/bds', listAgencyBds);
router.post('/bds', createAgencyBd);
router.post('/change-password', changeAgencyPassword);
router.patch('/profile', patchAgencyProfile);
router.get('/wallet', getAgencyWallet);
router.get('/wallet/transactions', getAgencyWalletTransactions);
router.get('/wallet/withdrawals', getAgencyWalletWithdrawals);
router.put('/wallet/payout-account', putAgencyWalletPayoutAccount);
router.post('/wallet/withdrawals', postAgencyWalletWithdrawal);
router.post('/staff-withdrawals', postAgencyStaffWithdrawalRequest);

export default router;
