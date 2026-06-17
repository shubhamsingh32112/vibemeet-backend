import { featureFlags } from '../../config/feature-flags';
import { isMomentsEnabled } from '../../config/moments';
import {
  getFreeCallDurationSeconds,
  getWelcomeIntroCallCreditsGrant,
  isFreeCallEnabled,
} from '../../config/free-call.config';
import { MIN_COINS_TO_CALL } from '../../config/pricing.config';

export interface PublicAppConfig {
  features: {
    vipEnabled: boolean;
    momentsEnabled: boolean;
  };
  pricing: {
    freeCallEnabled: boolean;
    freeCallDurationSeconds: number;
    welcomeIntroCallCredits: number;
    minCoinsToCall: number;
  };
}

export function getPublicAppConfig(): PublicAppConfig {
  return {
    features: {
      vipEnabled: featureFlags.vipEnabled,
      momentsEnabled: isMomentsEnabled(),
    },
    pricing: {
      freeCallEnabled: isFreeCallEnabled(),
      freeCallDurationSeconds: getFreeCallDurationSeconds(),
      welcomeIntroCallCredits: getWelcomeIntroCallCreditsGrant(),
      minCoinsToCall: MIN_COINS_TO_CALL,
    },
  };
}
