let latestEventLoopLagMs = 0;

export function setLatestEventLoopLagMs(value: number): void {
  if (!Number.isFinite(value) || value < 0) return;
  latestEventLoopLagMs = value;
}

export function getLatestEventLoopLagMs(): number {
  return latestEventLoopLagMs;
}
