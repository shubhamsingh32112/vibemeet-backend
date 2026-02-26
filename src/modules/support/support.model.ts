import mongoose, { Schema, Document } from 'mongoose';

/**
 * SupportTicket — Unified support system for Users & Creators.
 *
 * - `role` auto-set from the user's role at ticket creation time
 * - Admin can filter by role to separate User Tickets vs Creator Tickets
 * - Supports priority levels, assignment, and status tracking
 */
export interface ISupportTicket extends Document {
  _id: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  role: 'user' | 'creator';
  category: string;
  subject: string;
  message: string;
  source?: 'chat' | 'post_call' | 'other';
  relatedCallId?: string;
  reportedCreatorUserId?: mongoose.Types.ObjectId;
  reportedCreatorFirebaseUid?: string;
  reportedCreatorName?: string;
  status: 'open' | 'in_progress' | 'resolved' | 'closed';
  priority: 'low' | 'medium' | 'high' | 'urgent';
  assignedAdminId?: mongoose.Types.ObjectId;
  adminNotes?: string;
  createdAt: Date;
  updatedAt: Date;
}

const supportTicketSchema = new Schema<ISupportTicket>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    role: {
      type: String,
      enum: ['user', 'creator'],
      required: true,
      index: true,
    },
    category: {
      type: String,
      required: true,
      index: true,
    },
    subject: {
      type: String,
      required: true,
    },
    message: {
      type: String,
      required: true,
    },
    source: {
      type: String,
      enum: ['chat', 'post_call', 'other'],
      default: 'other',
      index: true,
    },
    relatedCallId: {
      type: String,
      trim: true,
      index: true,
      sparse: true,
    },
    reportedCreatorUserId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      sparse: true,
      index: true,
    },
    reportedCreatorFirebaseUid: {
      type: String,
      sparse: true,
      index: true,
    },
    reportedCreatorName: {
      type: String,
      trim: true,
      sparse: true,
    },
    status: {
      type: String,
      enum: ['open', 'in_progress', 'resolved', 'closed'],
      default: 'open',
      index: true,
    },
    priority: {
      type: String,
      enum: ['low', 'medium', 'high', 'urgent'],
      default: 'medium',
      index: true,
    },
    assignedAdminId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
    adminNotes: {
      type: String,
    },
  },
  {
    timestamps: true,
  }
);

// Compound indexes for common admin queries
supportTicketSchema.index({ role: 1, status: 1, createdAt: -1 });
supportTicketSchema.index({ status: 1, priority: 1, createdAt: -1 });
supportTicketSchema.index({ assignedAdminId: 1, status: 1 });
supportTicketSchema.index({ createdAt: -1 });

export const SupportTicket = mongoose.model<ISupportTicket>('SupportTicket', supportTicketSchema);
