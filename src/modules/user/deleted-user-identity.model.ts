import mongoose, { Document, Schema } from 'mongoose';

export type DeletedIdentityType = 'email' | 'phone';

export interface IDeletedUserIdentity extends Document {
  type: DeletedIdentityType;
  valueNormalized: string;
  valueHash: string;
  deletedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const deletedUserIdentitySchema = new Schema<IDeletedUserIdentity>(
  {
    type: {
      type: String,
      required: true,
      enum: ['email', 'phone'],
      index: true,
    },
    valueNormalized: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    // Prefer using hash for lookups to reduce raw PII exposure in queries/logs.
    valueHash: {
      type: String,
      required: true,
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

deletedUserIdentitySchema.index(
  { type: 1, valueHash: 1 },
  { unique: true, name: 'deleted_identity_type_hash_unique' }
);

export const DeletedUserIdentity = mongoose.model<IDeletedUserIdentity>(
  'DeletedUserIdentity',
  deletedUserIdentitySchema
);

