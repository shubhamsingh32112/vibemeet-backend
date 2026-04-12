/**
 * Parses app-generated Stream call IDs: `{callerFirebaseUid}_{creatorMongoId}_{unixSeconds}`.
 * Firebase UIDs do not contain `_`, so two underscores from the right delimit segments.
 */
export function parseAppVideoCallId(callId: string): {
  callerFirebaseUid: string;
  creatorMongoId: string;
  unixSeconds: string;
} | null {
  const last = callId.lastIndexOf('_');
  if (last <= 0) return null;
  const secondLast = callId.lastIndexOf('_', last - 1);
  if (secondLast <= 0) return null;

  const unixSeconds = callId.slice(last + 1);
  const creatorMongoId = callId.slice(secondLast + 1, last);
  const callerFirebaseUid = callId.slice(0, secondLast);

  if (!callerFirebaseUid || !/^\d+$/.test(unixSeconds)) return null;
  if (!/^[a-f0-9]{24}$/i.test(creatorMongoId)) return null;

  return { callerFirebaseUid, creatorMongoId, unixSeconds };
}
