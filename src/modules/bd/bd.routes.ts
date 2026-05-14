import { Router } from 'express';
import { verifyFirebaseToken } from '../../middlewares/auth.middleware';
import {
  getBdSummary,
  getBdDashboard,
  listBdAgencies,
  createBdAgency,
  changeBdPassword,
  patchBdProfile,
  postBdStaffWithdrawalRequest,
} from './bd-portal.controller';
import {
  getBdWallet,
  getBdWalletTransactions,
  getBdWalletWithdrawals,
  postBdWalletWithdrawal,
  putBdWalletPayoutAccount,
} from '../billing/staff-wallet-portal.controller';

const router = Router();
router.use(verifyFirebaseToken);

router.get('/summary', getBdSummary);
router.get('/dashboard', getBdDashboard);
router.get('/agencies', listBdAgencies);
router.post('/agencies', createBdAgency);
router.post('/change-password', changeBdPassword);
router.patch('/profile', patchBdProfile);
router.get('/wallet', getBdWallet);
router.get('/wallet/transactions', getBdWalletTransactions);
router.get('/wallet/withdrawals', getBdWalletWithdrawals);
router.put('/wallet/payout-account', putBdWalletPayoutAccount);
router.post('/wallet/withdrawals', postBdWalletWithdrawal);
router.post('/staff-withdrawals', postBdStaffWithdrawalRequest);

export default router;
