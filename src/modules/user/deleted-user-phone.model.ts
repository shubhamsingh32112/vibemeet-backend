import mongoose, { Document, Schema } from 'mongoose';

/**
 * Tracks phone numbers from deleted accounts to prevent welcome bonus abuse.
 * When a user deletes their account, we store their phone number here.
 * When they log in again with the same phone number, we check this collection
 * to prevent them from claiming the welcome bonus again.
 */
export interface IDeletedUserPhone extends Document {
  phone: string; // Phone number (indexed for fast lookup)
  welcomeBonusClaimed: boolean; // Whether this phone number had claimed welcome bonus
  deletedAt: Date; // When the account was deleted
  createdAt: Date;
  updatedAt: Date;
}

const deletedUserPhoneSchema = new Schema<IDeletedUserPhone>(
  {
    phone: {
      type: String,
      required: true,
      unique: true, // One record per phone number
      trim: true,
      index: true,
    },
    welcomeBonusClaimed: {
      type: Boolean,
      required: true,
      default: false,
    },
    deletedAt: {
      type: Date,
      required: true,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

export const DeletedUserPhone = mongoose.model<IDeletedUserPhone>(
  'DeletedUserPhone',
  deletedUserPhoneSchema
);
