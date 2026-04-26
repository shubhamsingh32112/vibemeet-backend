import mongoose, { Document, Schema } from 'mongoose';

export interface IGlobalAppUpdate extends Document {
  _id: mongoose.Types.ObjectId;
  version: string;
  title: string;
  points: string[];
  updateUrl: string;
  isActive: boolean;
  publishedAt: Date;
  createdBy: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

export interface IGlobalAppUpdateAck extends Document {
  _id: mongoose.Types.ObjectId;
  updateId: mongoose.Types.ObjectId;
  userId?: mongoose.Types.ObjectId;
  firebaseUid?: string;
  ackType: 'update_now_clicked';
  ackedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const globalAppUpdateSchema = new Schema<IGlobalAppUpdate>(
  {
    version: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      maxlength: 64,
      index: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
      maxlength: 160,
    },
    points: {
      type: [String],
      required: true,
      validate: {
        validator: (value: string[]) => Array.isArray(value) && value.length > 0,
        message: 'At least one point is required',
      },
    },
    updateUrl: {
      type: String,
      required: true,
      trim: true,
      maxlength: 1024,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    publishedAt: {
      type: Date,
      required: true,
      default: Date.now,
      index: true,
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

const globalAppUpdateAckSchema = new Schema<IGlobalAppUpdateAck>(
  {
    updateId: {
      type: Schema.Types.ObjectId,
      ref: 'GlobalAppUpdate',
      required: true,
      index: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: false,
      index: true,
    },
    firebaseUid: {
      type: String,
      required: false,
      trim: true,
      maxlength: 128,
      index: true,
    },
    ackType: {
      type: String,
      enum: ['update_now_clicked'],
      default: 'update_now_clicked',
      required: true,
    },
    ackedAt: {
      type: Date,
      default: Date.now,
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

globalAppUpdateAckSchema.pre('validate', function (next) {
  // Require an identifier for the ack: either Mongo userId (preferred) or firebaseUid fallback.
  // This makes the feature robust even if a Firebase user exists without a Mongo User row.
  if (!this.userId && !this.firebaseUid) {
    return next(new Error('GlobalAppUpdateAck requires either userId or firebaseUid'));
  }
  next();
});

globalAppUpdateAckSchema.index(
  { updateId: 1, userId: 1, ackType: 1 },
  {
    unique: true,
    partialFilterExpression: { userId: { $exists: true, $type: 'objectId' } },
    name: 'uniq_update_user_ack_type',
  }
);

globalAppUpdateAckSchema.index(
  { updateId: 1, firebaseUid: 1, ackType: 1 },
  {
    unique: true,
    partialFilterExpression: { firebaseUid: { $exists: true, $type: 'string' } },
    name: 'uniq_update_firebase_uid_ack_type',
  }
);

// Enforce single active update at DB level when partial indexes are available.
globalAppUpdateSchema.index(
  { isActive: 1 },
  {
    unique: true,
    partialFilterExpression: { isActive: true },
    name: 'uniq_single_active_global_app_update',
  }
);

export const GlobalAppUpdate = mongoose.model<IGlobalAppUpdate>(
  'GlobalAppUpdate',
  globalAppUpdateSchema
);

export const GlobalAppUpdateAck = mongoose.model<IGlobalAppUpdateAck>(
  'GlobalAppUpdateAck',
  globalAppUpdateAckSchema
);
