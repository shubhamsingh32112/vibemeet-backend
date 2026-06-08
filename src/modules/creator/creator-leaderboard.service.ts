import {
  leaderboardHosts,
  type HostLeaderboardSort,
  type LeaderboardPeriod,
} from '../admin/admin-leaderboards.service';
import {
  CREATOR_LEADERBOARD_DEFAULT_PERIOD,
  CREATOR_LEADERBOARD_DEFAULT_SORT,
  CREATOR_LEADERBOARD_TOP_REWARD_COINS,
  CREATOR_LEADERBOARD_TOP_REWARD_RANK,
} from './creator-leaderboard.config';

export async function getCreatorLeaderboardSummary(creatorUserId: string) {
  const period = CREATOR_LEADERBOARD_DEFAULT_PERIOD;
  const sort = CREATOR_LEADERBOARD_DEFAULT_SORT as HostLeaderboardSort;

  const data = await leaderboardHosts({
    period,
    sort,
    limit: 500,
  });

  const rankRow = data.rows.find((r) => r.hostUserId === creatorUserId);

  return {
    rank: rankRow?.rank ?? null,
    totalCreators: data.rows.length,
    period,
    sort,
    topRewardCoins: CREATOR_LEADERBOARD_TOP_REWARD_COINS,
    topRewardRank: CREATOR_LEADERBOARD_TOP_REWARD_RANK,
  };
}

export async function getCreatorLeaderboardList(params?: {
  period?: LeaderboardPeriod;
  sort?: HostLeaderboardSort;
  limit?: number;
}) {
  return leaderboardHosts({
    period: params?.period ?? CREATOR_LEADERBOARD_DEFAULT_PERIOD,
    sort: params?.sort ?? (CREATOR_LEADERBOARD_DEFAULT_SORT as HostLeaderboardSort),
    limit: params?.limit ?? 50,
  });
}
