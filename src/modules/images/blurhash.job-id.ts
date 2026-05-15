/** Stable BullMQ job id (colons forbidden in custom ids since BullMQ v5.58+). */
export function blurhashJobId(imageId: string): string {
  return `blurhash-${imageId}`;
}
