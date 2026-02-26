import { Router } from 'express';
import { verifyFirebaseToken } from '../../middlewares/auth.middleware';
import { createTicket, getMyTickets, submitCallFeedback } from './support.controller';

const router = Router();

// All support routes require authentication
router.use(verifyFirebaseToken);

router.post('/ticket', createTicket);
router.post('/call-feedback', submitCallFeedback);
router.get('/my-tickets', getMyTickets);

export default router;
