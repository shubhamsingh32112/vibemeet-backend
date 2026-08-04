import { featureFlags } from '../../config/feature-flags';
import { getMomentsAccessMode, isMomentsEnabled } from '../../config/moments';
import {
  getFreeCallDurationSeconds,
  getWelcomeIntroCallCreditsGrant,
  isFreeCallEnabled,
} from '../../config/free-call.config';
import { MIN_COINS_TO_CALL } from '../../config/pricing.config';
import { isTelegramRewardEnabled } from '../telegram-reward/telegram-reward-config.model';
import { isConsumerRewardsEnabled } from '../consumer-rewards/consumer-reward-config.model';

export interface PublicAppConfig {
  features: {
    vipEnabled: boolean;
    vipProfileFrameEnabled: boolean;
    momentsEnabled: boolean;
    momentsAccessMode: 'free' | 'paid';
    dailyCheckInEnabled: boolean;
    telegramRewardEnabled: boolean;
    consumerRewardsEnabled: boolean;
  };
  pricing: {
    freeCallEnabled: boolean;
    freeCallDurationSeconds: number;
    welcomeIntroCallCredits: number;
    minCoinsToCall: number;
  };
}

export async function getPublicAppConfig(): Promise<PublicAppConfig> {
  const [telegramRewardEnabled, consumerRewardsEnabled] = await Promise.all([
    isTelegramRewardEnabled(),
    isConsumerRewardsEnabled(),
  ]);
  return {
    features: {
      vipEnabled: featureFlags.vipEnabled,
      vipProfileFrameEnabled: featureFlags.vipProfileFrameEnabled,
      momentsEnabled: isMomentsEnabled(),
      momentsAccessMode: getMomentsAccessMode(),
      dailyCheckInEnabled: featureFlags.dailyCheckInEnabled,
      telegramRewardEnabled,
      consumerRewardsEnabled,
    },
    pricing: {
      freeCallEnabled: isFreeCallEnabled(),
      freeCallDurationSeconds: getFreeCallDurationSeconds(),
      welcomeIntroCallCredits: getWelcomeIntroCallCreditsGrant(),
      minCoinsToCall: MIN_COINS_TO_CALL,
    },
  };
}
