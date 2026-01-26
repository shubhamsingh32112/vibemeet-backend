import { Router } from 'express';
import { verifyFirebaseToken } from '../../middlewares/auth.middleware';
import {
  getAllCreators,
  getCreatorById,
  createCreator,
  updateCreator,
  deleteCreator,
} from './creator.controller';

const router = Router();

// Routes that require authentication to check user role
router.get('/', verifyFirebaseToken, getAllCreators);
router.get('/:id', getCreatorById);

// Protected routes (require authentication)
router.post('/', verifyFirebaseToken, createCreator);
router.put('/:id', verifyFirebaseToken, updateCreator);
router.delete('/:id', verifyFirebaseToken, deleteCreator);

export default router;
