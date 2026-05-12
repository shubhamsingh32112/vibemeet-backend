import mongoose, { Document, Schema } from 'mongoose';

/**
 * Immutable operational audit stream (append-only). Complements AdminActionLog for structured queries.
 */
export interface IAuditEvent extends Document {
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
  createdAt: Date;
}

const auditEventSchema = new Schema<IAuditEvent>(
  {
    actorUserId: { type: Schema.Types.ObjectId, ref: 'User', index: true, sparse: true },
    actorRole: { type: String, trim: true, index: true, sparse: true },
    eventType: { type: String, required: true, index: true },
    targetType: { type: String, required: true, index: true },
    targetId: { type: String, required: true, index: true },
    metadata: { type: Schema.Types.Mixed, default: {} },
    ipAddress: { type: String, trim: true, sparse: true },
    userAgent: { type: String, trim: true, sparse: true },
    correlationId: { type: String, trim: true, sparse: true, index: true },
    requestId: { type: String, trim: true, sparse: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

auditEventSchema.index({ createdAt: -1 });
auditEventSchema.index({ actorUserId: 1, createdAt: -1 });
auditEventSchema.index({ eventType: 1, createdAt: -1 });
auditEventSchema.index({ targetType: 1, targetId: 1, createdAt: -1 });

export const AuditEvent = mongoose.model<IAuditEvent>('AuditEvent', auditEventSchema);
