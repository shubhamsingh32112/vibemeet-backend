import mongoose, { Document, Schema } from 'mongoose';

export interface IWebhookEvent extends Document {
  eventId: string;
  type: string;
  callCid?: string;
  callId?: string;
  sessionId?: string;
  rawPayload: any;
  createdAt: Date;
}

const webhookEventSchema = new Schema<IWebhookEvent>(
  {
    eventId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    type: {
      type: String,
      required: true,
      index: true,
    },
    callCid: {
      type: String,
      index: true,
    },
    callId: {
      type: String,
      index: true,
    },
    sessionId: {
      type: String,
      index: true,
    },
    rawPayload: {
      type: Schema.Types.Mixed,
      required: true,
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  }
);

export const WebhookEvent = mongoose.model<IWebhookEvent>(
  'WebhookEvent',
  webhookEventSchema
);

