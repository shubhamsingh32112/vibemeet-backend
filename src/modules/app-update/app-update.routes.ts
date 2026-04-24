import { Router } from 'express';
import { verifyFirebaseToken } from '../../middlewares/auth.middleware';
import {
  ackGlobalAppUpdateNow,
  getPendingGlobalAppUpdate,
} from './app-update.controller';

const router = Router();

router.use(verifyFirebaseToken);
router.get('/pending', getPendingGlobalAppUpdate);
router.post('/:id/ack-update-now', ackGlobalAppUpdateNow);

export default router;
