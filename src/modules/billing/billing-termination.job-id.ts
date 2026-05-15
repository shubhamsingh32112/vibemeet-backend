/** Stable BullMQ job id (colons forbidden in custom ids since BullMQ v5.58+). */
export function terminateCallJobId(callId: string): string {
  return `terminate-${callId}`;
}
