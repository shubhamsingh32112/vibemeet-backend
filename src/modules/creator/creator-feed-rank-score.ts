const MAX_TS = 9_000_000_000_000;

export type CreatorPresenceRankState = 'online' | 'on_call' | 'offline';

function availabilityRank(state: CreatorPresenceRankState | undefined): number {
  if (state === 'online') return 0;
  if (state === 'on_call') return 1;
  return 2;
}

export function encodeFeedRankScore(
  state: CreatorPresenceRankState | undefined,
  createdAtMs: number
): number {
  const tier = availabilityRank(state);
  const tieBreak = Math.max(0, MAX_TS - Math.max(0, createdAtMs));
  return tier * 1e13 + tieBreak;
}
