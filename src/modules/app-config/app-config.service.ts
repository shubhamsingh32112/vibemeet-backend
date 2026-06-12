import { featureFlags } from '../../config/feature-flags';
import { isMomentsEnabled } from '../../config/moments';
import {
  MIN_COINS_TO_CALL,
  WELCOME_INTRO_CALL_CREDITS,
} from '../../config/pricing.config';

export interface PublicAppConfig {
  features: {
    vipEnabled: boolean;
    momentsEnabled: boolean;
  };
  pricing: {
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
      welcomeIntroCallCredits: WELCOME_INTRO_CALL_CREDITS,
      minCoinsToCall: MIN_COINS_TO_CALL,
    },
  };
}
