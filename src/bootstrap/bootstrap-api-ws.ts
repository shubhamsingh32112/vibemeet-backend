import type { Server } from 'socket.io';
import { featureFlags } from '../config/feature-flags';
import { getRedisEndpointMode } from '../config/redis';
import { setupAvailabilityGateway } from '../modules/availability/availability.gateway';
import { auditCreatorPresenceOnStartup } from '../modules/availability/creator-presence-audit.service';
import { setupBillingGateway } from '../modules/billing/billing.gateway';
import { setupMomentsGateway } from '../modules/moments/moments.gateway';
import { setupAdminGateway } from '../modules/admin/admin.gateway';
import { logInfo, logError } from '../utils/logger';

export function bootstrapApiWs(io: Server): void {
  setupAvailabilityGateway(io);
  setupMomentsGateway(io);
  logInfo('Socket.IO availability gateway ready');

  auditCreatorPresenceOnStartup(io, 'server.startup').catch((err) => {
    logError('Creator presence startup audit failed', err);
  });

  logInfo('creator_presence_runtime_config', {
    redisEndpointMode: getRedisEndpointMode(),
    userModelEnabled: featureFlags.creatorPresenceUserModelEnabled,
    userModelShadowCompareEnabled: featureFlags.creatorPresenceUserModelShadowCompareEnabled,
  });

  setupBillingGateway(io);
  logInfo('Socket.IO billing gateway ready');

  setupAdminGateway(io);
  logInfo('Socket.IO admin gateway ready');
}
