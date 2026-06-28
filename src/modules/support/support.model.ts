import mongoose, { Schema, Document } from 'mongoose';
import {
  MEMBERSHIP_TIERS,
  type MembershipTier,
} from '../membership/membership-tier';

export interface ISupportTicketAttachment {
  name: string;
  mimeType: string;
  sizeBytes: number;
  isScreenshot: boolean;
  /** Legacy inline storage (read-only for old tickets). */
  dataBase64?: string;
  /** Cloudflare Images id (preferred for new tickets). */
  imageId?: string;
  /** CDN delivery URL (galleryMd). */
  url?: string;
}

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
  role: 'user' | 'creator' | 'agency' | 'bd';
  category: string;
  subject: string;
  message: string;
  /** Contact phone provided by submitter (E.164). Required for app users; optional for staff portal. */
  contactPhone?: string;
  attachments: ISupportTicketAttachment[];
  source?: 'chat' | 'post_call' | 'other' | 'staff_portal';
  relatedCallId?: string;
  reportedCreatorUserId?: mongoose.Types.ObjectId;
  reportedCreatorFirebaseUid?: string;
  reportedCreatorName?: string;
  status: 'open' | 'in_progress' | 'resolved' | 'closed';
  priority: 'low' | 'medium' | 'high' | 'urgent';
  submitterMembershipTier: MembershipTier;
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
      enum: ['user', 'creator', 'agency', 'bd'],
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
    contactPhone: {
      type: String,
      trim: true,
      maxlength: 20,
      index: true,
      sparse: true,
    },
    attachments: {
      type: [
        {
          name: {
            type: String,
            required: true,
            trim: true,
            maxlength: 120,
          },
          mimeType: {
            type: String,
            required: true,
            trim: true,
            maxlength: 64,
          },
          sizeBytes: {
            type: Number,
            required: true,
            min: 0,
          },
          dataBase64: {
            type: String,
          },
          imageId: {
            type: String,
            trim: true,
          },
          url: {
            type: String,
            trim: true,
          },
          isScreenshot: {
            type: Boolean,
            default: false,
          },
        },
      ],
      default: [],
    },
    source: {
      type: String,
      enum: ['chat', 'post_call', 'other', 'staff_portal'],
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
    submitterMembershipTier: {
      type: String,
      enum: MEMBERSHIP_TIERS,
      default: 'NONE',
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
