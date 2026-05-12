import mongoose, { Document, Schema } from 'mongoose';
import type { DomainEventStatus } from './domain-event.types';

export interface IDomainEvent extends Document {
  eventId: string;
  eventType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  status: DomainEventStatus;
  retryCount: number;
  idempotencyKey?: string;
  createdAt: Date;
  processedAt?: Date;
  lastError?: string;
}

const domainEventSchema = new Schema<IDomainEvent>(
  {
    eventId: { type: String, required: true, unique: true, index: true },
    eventType: { type: String, required: true, index: true },
    aggregateId: { type: String, required: true, index: true },
    payload: { type: Schema.Types.Mixed, required: true },
    status: {
      type: String,
      enum: ['pending', 'processed', 'failed', 'dead'],
      default: 'pending',
      index: true,
    },
    retryCount: { type: Number, default: 0 },
    idempotencyKey: { type: String, trim: true, sparse: true, unique: true },
    processedAt: { type: Date },
    lastError: { type: String, trim: true, maxlength: 2000 },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

domainEventSchema.index({ status: 1, createdAt: 1 });

export const DomainEvent = mongoose.model<IDomainEvent>('DomainEvent', domainEventSchema);
