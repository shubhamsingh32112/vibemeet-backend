/**
 * Staff dashboard invalidation — domain events + v1 `dashboard:invalidate` adapter.
 *
 * Ordering guarantees (documented for frontend):
 * - Eventually consistent: stale hints arrive after domain events; data is fresh only after HTTP refresh.
 * - No ordering between unrelated events.
 * - Events may be coalesced (v2 presence) or missed during disconnect; reconnect marks all sections stale.
 */
import { getIO } from '../../config/socket';
import { getRedis } from '../../config/redis';
import { logWarning } from '../../utils/logger';
import { Creator } from '../creator/creator.model';
import { User } from '../user/user.model';
import {
  isBdRole,
  isAgencyRole,
} from '../../utils/staff-roles';
import {
  ADMIN_SOCKET_ROOM,
  agencySocketRoom,
  bdSocketRoom,
} from './staff-socket.constants';

export type DashboardSection =
  | 'revenue'
  | 'calls'
  | 'creators'
  | 'withdrawals'
  | 'support'
  | 'bds'
  | 'overview'
  | 'realtime'
  | 'fraud'
  | 'moderation';

export type StaffDomainEventType =
  | 'billing:settled'
  | 'creator:status_changed'
  | 'withdrawal:created'
  | 'withdrawal:updated'
  | 'support:changed'
  | 'wallet:pricing_updated'
  | 'dashboard:data_changed';

export interface StaffDomainEvent {
  type: StaffDomainEventType;
  scope: { bdId?: string; agencyId?: string };
  entityId?: string;
  timestamp?: string;
  meta?: Record<string, string | number | boolean>;
}

export interface DashboardInvalidatePayload extends StaffDomainEvent {
  affected: DashboardSection[];
  timestamp: string;
}

const CREATOR_STAFF_SCOPE_PREFIX = 'creator:staff_scope:';
const CREATOR_STAFF_SCOPE_TTL_SEC = 86400;

const DOMAIN_TO_SECTIONS: Record<StaffDomainEventType, DashboardSection[]> = {
  'billing:settled': ['revenue', 'calls'],
  'creator:status_changed': ['creators', 'realtime'],
  'withdrawal:created': ['withdrawals'],
  'withdrawal:updated': ['withdrawals'],
  'support:changed': ['support'],
  'wallet:pricing_updated': ['revenue'],
  'dashboard:data_changed': [],
};

const LEGACY_EVENT_MAP: Partial<Record<StaffDomainEventType, string>> = {
  'billing:settled': 'billing:settled',
  'creator:status_changed': 'creator:status',
  'withdrawal:created': 'withdrawal:requested',
  'withdrawal:updated': 'withdrawal:updated',
  'support:changed': 'support:ticket_updated',
  'wallet:pricing_updated': 'wallet_pricing_updated',
};

export async function resolveStaffUserScope(
  staffUserId: string
): Promise<{ bdId?: string; agencyId?: string }> {
  try {
    const user = await User.findById(staffUserId).select('role bdId').lean();
    if (!user) return {};
    if (isAgencyRole(user.role)) {
      return {
        agencyId: staffUserId,
        bdId: user.bdId?.toString(),
      };
    }
    if (isBdRole(user.role)) {
      return { bdId: staffUserId };
    }
  } catch {
    /* ignore */
  }
  return {};
}

export function mapDomainEventToSections(
  type: StaffDomainEventType,
  override?: DashboardSection[]
): DashboardSection[] {
  if (override && override.length > 0) return override;
  return DOMAIN_TO_SECTIONS[type] ?? [];
}

function staffScopeKey(firebaseUid: string): string {
  return `${CREATOR_STAFF_SCOPE_PREFIX}${firebaseUid}`;
}

export async function setCreatorStaffScope(
  firebaseUid: string,
  scope: { bdId?: string; agencyId?: string }
): Promise<void> {
  if (!scope.bdId && !scope.agencyId) return;
  try {
    const redis = getRedis();
    await redis.setex(staffScopeKey(firebaseUid), CREATOR_STAFF_SCOPE_TTL_SEC, JSON.stringify(scope));
  } catch {
    /* non-fatal */
  }
}

export async function getCreatorStaffScope(
  firebaseUid: string
): Promise<{ bdId?: string; agencyId?: string }> {
  try {
    const redis = getRedis();
    const raw = await redis.get(staffScopeKey(firebaseUid));
    if (raw) {
      const parsed = JSON.parse(raw) as { bdId?: string; agencyId?: string };
      return parsed;
    }
  } catch {
    /* fall through */
  }

  try {
    const byFirebase = await User.findOne({ firebaseUid }).select('_id').lean();
    if (!byFirebase) return {};
    const c = await Creator.findOne({ userId: byFirebase._id })
      .select('assignedAgencyId')
      .lean();
    if (!c?.assignedAgencyId) return {};
    const agencyId = c.assignedAgencyId.toString();
    const agencyUser = await User.findById(c.assignedAgencyId).select('bdId').lean();
    const bdId = agencyUser?.bdId?.toString();
    const scope = { agencyId, bdId };
    await setCreatorStaffScope(firebaseUid, scope);
    return scope;
  } catch {
    return {};
  }
}

function buildInvalidatePayload(
  event: StaffDomainEvent,
  affected: DashboardSection[]
): DashboardInvalidatePayload {
  return {
    ...event,
    affected,
    timestamp: event.timestamp ?? new Date().toISOString(),
  };
}

function emitToRoom(room: string, payload: DashboardInvalidatePayload): void {
  try {
    const ns = getIO().of('/admin');
    ns.to(room).emit('dashboard:invalidate', payload);
    const legacy = LEGACY_EVENT_MAP[payload.type];
    if (legacy) {
      ns.to(room).emit(legacy, payload);
    }
  } catch (err) {
    logWarning('Failed to emit dashboard invalidation', { room, type: payload.type, error: err });
  }
}

/**
 * Emit domain event as dashboard invalidation to scoped rooms only.
 */
const presenceCoalesceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const presenceCoalescePending = new Map<string, StaffDomainEvent>();

function presenceCoalesceKey(event: StaffDomainEvent): string {
  const rooms = [
    'admin',
    event.scope.agencyId ? `agency:${event.scope.agencyId}` : '',
    event.scope.bdId ? `bd:${event.scope.bdId}` : '',
  ]
    .filter(Boolean)
    .join('|');
  return `${rooms}:creators`;
}

function flushPresenceCoalesce(key: string): void {
  const event = presenceCoalescePending.get(key);
  presenceCoalescePending.delete(key);
  presenceCoalesceTimers.delete(key);
  if (event) {
    emitStaffDomainEventImmediate(event);
  }
}

function emitStaffDomainEventImmediate(
  event: StaffDomainEvent,
  affectedOverride?: DashboardSection[]
): void {
  const affected = mapDomainEventToSections(event.type, affectedOverride);
  const payload = buildInvalidatePayload(event, affected);
  const { bdId, agencyId } = event.scope;

  emitToRoom(ADMIN_SOCKET_ROOM, payload);

  if (agencyId) {
    emitToRoom(agencySocketRoom(agencyId), payload);
  }
  if (bdId) {
    emitToRoom(bdSocketRoom(bdId), payload);
  }
}

export function emitStaffDomainEvent(
  event: StaffDomainEvent,
  affectedOverride?: DashboardSection[]
): void {
  const coalesceMs = parseInt(process.env.PRESENCE_INVALIDATION_COALESCE_MS ?? '0', 10);
  if (event.type === 'creator:status_changed' && coalesceMs > 0) {
    const key = presenceCoalesceKey(event);
    presenceCoalescePending.set(key, event);
    const existing = presenceCoalesceTimers.get(key);
    if (existing) clearTimeout(existing);
    presenceCoalesceTimers.set(
      key,
      setTimeout(() => flushPresenceCoalesce(key), coalesceMs)
    );
    return;
  }
  emitStaffDomainEventImmediate(event, affectedOverride);
}

/** @deprecated Use emitStaffDomainEvent — kept for gradual migration */
export function emitToAdmin(event: string, data: unknown): void {
  const legacyToDomain: Record<string, StaffDomainEventType> = {
    'billing:settled': 'billing:settled',
    'creator:status': 'creator:status_changed',
    'withdrawal:requested': 'withdrawal:created',
    'withdrawal:updated': 'withdrawal:updated',
    'support:ticket_created': 'support:changed',
    'support:ticket_updated': 'support:changed',
    wallet_pricing_updated: 'wallet:pricing_updated',
    'metrics:refresh': 'dashboard:data_changed',
  };

  const domainType = legacyToDomain[event];
  if (domainType) {
    const d = (data ?? {}) as Record<string, unknown>;
    const scope: StaffDomainEvent['scope'] = {};
    if (typeof d.bdId === 'string') scope.bdId = d.bdId;
    if (typeof d.agencyId === 'string') scope.agencyId = d.agencyId;
    if (typeof d.agencyUserId === 'string') scope.agencyId = d.agencyUserId;
    if (typeof d.assignedAgencyId === 'string') scope.agencyId = d.assignedAgencyId;

    const entityId =
      typeof d.callId === 'string'
        ? d.callId
        : typeof d.ticketId === 'string'
          ? d.ticketId
          : typeof d.withdrawalId === 'string'
            ? d.withdrawalId
            : undefined;

    const baseEvent: StaffDomainEvent = {
      type: domainType,
      scope,
      entityId,
      meta: d as Record<string, string | number | boolean>,
    };

    if (typeof d.staffUserId === 'string' && !scope.bdId && !scope.agencyId) {
      void resolveStaffUserScope(d.staffUserId).then((resolved) => {
        emitStaffDomainEvent({
          ...baseEvent,
          scope: { ...scope, ...resolved },
        });
      });
      return;
    }

    emitStaffDomainEvent(baseEvent);
    return;
  }

  try {
    const payload =
      data !== null && typeof data === 'object'
        ? { ...(data as Record<string, unknown>), timestamp: new Date().toISOString() }
        : { data, timestamp: new Date().toISOString() };
    const ns = getIO().of('/admin');
    ns.to(ADMIN_SOCKET_ROOM).emit(event, payload);
  } catch (err) {
    logWarning('Failed to emit admin event', { event, error: err });
  }
}
