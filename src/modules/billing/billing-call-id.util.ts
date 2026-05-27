/**
 * Parses app-generated Stream call IDs:
 * - `{initiatorFirebaseUid}_{creatorMongoId}_{unixSeconds}` (current)
 * - `{initiatorFirebaseUid}_{creatorMongoId}` (legacy)
 * Firebase UIDs do not contain `_`, so delimiters are safe from the right.
 */
export function parseAppVideoCallId(callId: string): {
  initiatorFirebaseUid: string;
  creatorMongoId: string;
  unixSeconds?: string;
} | null {
  const last = callId.lastIndexOf('_');
  if (last <= 0) return null;

  const secondLast = callId.lastIndexOf('_', last - 1);
  let unixSeconds: string | undefined;
  let creatorMongoId: string;
  let initiatorFirebaseUid: string;
  const tail = callId.slice(last + 1);

  if (secondLast > 0 && /^\d+$/.test(tail)) {
    unixSeconds = tail;
    creatorMongoId = callId.slice(secondLast + 1, last);
    initiatorFirebaseUid = callId.slice(0, secondLast);
  } else {
    creatorMongoId = tail;
    initiatorFirebaseUid = callId.slice(0, last);
  }

  if (!initiatorFirebaseUid) return null;
  if (!/^[a-f0-9]{24}$/i.test(creatorMongoId)) return null;

  return unixSeconds
    ? { initiatorFirebaseUid, creatorMongoId, unixSeconds }
    : { initiatorFirebaseUid, creatorMongoId };
}
