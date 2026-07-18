import { Router } from 'express';
import { websiteHomepageVisitLimiter } from '../../middlewares/rate-limit.middleware';
import { recordWebsiteHomepageVisit } from './website-visits.controller';

const router = Router();

router.post('/website-homepage-visit', websiteHomepageVisitLimiter, recordWebsiteHomepageVisit);

export default router;
