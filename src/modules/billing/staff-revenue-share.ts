/**
 * Staff revenue share math (BD/agency cuts from host earnings at settlement).
 * Creator wallet is credited in full; staff cuts are separate ledger credits.
 */

export type StaffCutsFromHost = {
  bdCut: number;
  agencyCut: number;
};

/** Basis points of host-earned coins (same formula as billing-settlement.service). */
export function computeStaffCutsFromHostEarnings(
  totalEarnedCreator: number,
  bdBps: number,
  agencyBps: number,
  hasBd: boolean
): StaffCutsFromHost {
  const bdCut = hasBd ? Math.floor((totalEarnedCreator * bdBps) / 10000) : 0;
  const agencyCut = Math.floor((totalEarnedCreator * agencyBps) / 10000);
  return { bdCut, agencyCut };
}

export type RevenueSplitDisplaySlice = {
  key: string;
  label: string;
  /** % of total user call spend (gross). */
  pct: number;
};

/** Derive gross % slices: staff bps apply to host earnings, not gross. */
export function computeRevenueSplitDisplayPercents(
  hostSharePct: number,
  bdBps: number,
  agencyBps: number
): RevenueSplitDisplaySlice[] {
  const host = hostSharePct;
  const bd = (host * bdBps) / 10000;
  const agency = (host * agencyBps) / 10000;
  const platform = Math.max(0, 100 - host - bd - agency);
  const round = (n: number) => Math.round(n * 1000) / 1000;
  return [
    { key: 'host', label: 'Host', pct: round(host) },
    { key: 'bd', label: 'BD', pct: round(bd) },
    { key: 'agency', label: 'Agency', pct: round(agency) },
    { key: 'platform', label: 'Platform', pct: round(platform) },
  ];
}

export function computeIndependentHostDisplayPercents(
  hostSharePct: number
): RevenueSplitDisplaySlice[] {
  const platform = Math.max(0, 100 - hostSharePct);
  return [
    { key: 'host', label: 'Host', pct: hostSharePct },
    { key: 'platform', label: 'Platform', pct: platform },
  ];
}
