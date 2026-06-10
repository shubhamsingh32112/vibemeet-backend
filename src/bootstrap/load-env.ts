import dotenv from 'dotenv';
import { getServiceRole } from '../config/service-role';
import { resolveBillingInstanceIdFromEcs } from './bootstrap-ecs-metadata';

dotenv.config();
getServiceRole();

void resolveBillingInstanceIdFromEcs();
