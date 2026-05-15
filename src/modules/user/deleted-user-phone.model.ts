import mongoose, { Document, Schema } from 'mongoose';

/**
 * Legacy phone record for deleted accounts (identity / anti-abuse bookkeeping).
 * New flows prefer `deleted-identity` data; this collection remains for back-compat.
 */
export interface IDeletedUserPhone extends Document {
  phone: string; // Phone number (indexed for fast lookup)
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
