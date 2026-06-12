import { Router } from 'express';
import { getAppConfig } from './app-config.controller';

const router = Router();

router.get('/', getAppConfig);

export default router;
