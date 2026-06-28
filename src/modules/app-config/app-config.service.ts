import { featureFlags } from '../../config/feature-flags';
import { getMomentsAccessMode, isMomentsEnabled } from '../../config/moments';
import {
  getFreeCallDurationSeconds,
  getWelcomeIntroCallCreditsGrant,
  isFreeCallEnabled,
} from '../../config/free-call.config';
import { MIN_COINS_TO_CALL } from '../../config/pricing.config';

export interface PublicAppConfig {
  features: {
    vipEnabled: boolean;
    vipProfileFrameEnabled: boolean;
    momentsEnabled: boolean;
    momentsAccessMode: 'free' | 'paid';
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
      vipProfileFrameEnabled: featureFlags.vipProfileFrameEnabled,
      momentsEnabled: isMomentsEnabled(),
      momentsAccessMode: getMomentsAccessMode(),
    },
    pricing: {
      freeCallEnabled: isFreeCallEnabled(),
      freeCallDurationSeconds: getFreeCallDurationSeconds(),
      welcomeIntroCallCredits: getWelcomeIntroCallCreditsGrant(),
      minCoinsToCall: MIN_COINS_TO_CALL,
    },
  };
}
