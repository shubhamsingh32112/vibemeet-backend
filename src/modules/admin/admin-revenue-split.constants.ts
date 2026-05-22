import { CREATOR_SHARE_PERCENTAGE } from '../../config/pricing.config';
import { getOrCreatePlatformRevenueConfig } from '../payment/platform-revenue-config.model';
import {
  computeIndependentHostDisplayPercents,
  computeRevenueSplitDisplayPercents,
} from '../billing/staff-revenue-share';

export function hostSharePctFromConfig(): number {
  return Math.round(CREATOR_SHARE_PERCENTAGE * 1000) / 10;
}

/** Policy % of call spend for charts (derived from host share × staff bps). */
export async function getSplitWithStaffPct(): Promise<
  ReturnType<typeof computeRevenueSplitDisplayPercents>
> {
  const cfg = await getOrCreatePlatformRevenueConfig();
  return computeRevenueSplitDisplayPercents(hostSharePctFromConfig(), cfg.bdBps, cfg.agencyBps);
}

export async function getSplitIndependentHostPct(): Promise<
  ReturnType<typeof computeIndependentHostDisplayPercents>
> {
  return computeIndependentHostDisplayPercents(hostSharePctFromConfig());
}
