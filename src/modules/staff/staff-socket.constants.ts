/** Staff dashboard Socket.IO room names. */
export const ADMIN_SOCKET_ROOM = 'staff:admin';

export function agencySocketRoom(agencyUserId: string): string {
  return `agency:${agencyUserId}`;
}

export function bdSocketRoom(bdUserId: string): string {
  return `bd:${bdUserId}`;
}
