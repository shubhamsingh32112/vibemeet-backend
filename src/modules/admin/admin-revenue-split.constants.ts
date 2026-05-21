/** Policy % of call spend (display / scenario coins). */
export const SPLIT_WITH_STAFF_PCT = [
  { key: 'host', label: 'Host', pct: 25 },
  { key: 'bd', label: 'BD', pct: 5 },
  { key: 'agency', label: 'Agency', pct: 15 },
  { key: 'platform', label: 'Platform', pct: 55 },
] as const;

export const SPLIT_INDEPENDENT_HOST_PCT = [
  { key: 'host', label: 'Host', pct: 25 },
  { key: 'platform', label: 'Platform', pct: 75 },
] as const;
