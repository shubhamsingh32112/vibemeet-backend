import type { Request } from 'express';
import mongoose from 'mongoose';
import { AuditEvent } from './audit-event.model';

export type AppendAuditEventInput = {
  actorUserId?: mongoose.Types.ObjectId | null;
  actorRole?: string;
  eventType: string;
  targetType: string;
  targetId: string;
  metadata?: Record<string, unknown>;
  ipAddress?: string | null;
  userAgent?: string | null;
  correlationId?: string | null;
  requestId?: string | null;
};

function clientIp(req: Request): string | null {
  const xf = req.headers['x-forwarded-for'];
  const first =
    typeof xf === 'string'
      ? xf.split(',')[0]?.trim()
      : Array.isArray(xf)
        ? xf[0]
        : undefined;
  if (first) return first;
  if (req.ip) return req.ip;
  return null;
}

/** Extract propagation fields from Express request (optional). */
export function extractAuditContext(req: Request): {
  ipAddress: string | null;
  userAgent: string | null;
  correlationId: string | null;
  requestId: string | null;
} {
  const ua = req.headers['user-agent'];
  return {
    ipAddress: clientIp(req),
    userAgent: typeof ua === 'string' ? ua.slice(0, 512) : null,
    correlationId: req.correlationId ?? null,
    requestId: req.requestId ?? null,
  };
}

/** Fire-and-forget safe — never throws to callers of business logic. */
export async function appendAuditEvent(input: AppendAuditEventInput): Promise<void> {
  try {
    await AuditEvent.create({
      actorUserId: input.actorUserId ?? undefined,
      actorRole: input.actorRole,
      eventType: input.eventType,
      targetType: input.targetType,
      targetId: input.targetId,
      metadata: input.metadata ?? {},
      ipAddress: input.ipAddress ?? undefined,
      userAgent: input.userAgent ?? undefined,
      correlationId: input.correlationId ?? undefined,
      requestId: input.requestId ?? undefined,
    });
  } catch {
    // Never fail primary operation on audit insert failure
  }
}
