import mongoose, { Document, Schema } from 'mongoose';

export interface ICreator extends Document {
  _id: mongoose.Types.ObjectId;
  name: string;
  about: string;
  photo: string; // URL or path to photo
  userId: mongoose.Types.ObjectId; // Reference to User document (REQUIRED - creator cannot exist without user)
  categories: string[]; // Array of category names (optional)
  price: number; // Price per minute in coins (e.g., 60 = 60 coins per minute)
  isOnline: boolean; // Online/offline status for creators
  currentCallId?: string; // Current active call ID (locks creator from accepting other calls)
  earningsCoins: number; // Total creator earnings from video calls
  createdAt: Date;
  updatedAt: Date;
}

const creatorSchema = new Schema<ICreator>(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      minlength: 2,
      maxlength: 100,
    },
    about: {
      type: String,
      required: true,
      trim: true,
      minlength: 10,
      maxlength: 1000,
    },
    photo: {
      type: String,
      required: true,
      trim: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true, // DB-level constraint: No two creators can point to the same user (prevents double promotion)
      index: true,
    },
    categories: {
      type: [String],
      default: [],
    },
    price: {
      type: Number,
      required: true,
      min: 0,
    },
    isOnline: {
      type: Boolean,
      default: false,
      index: true, // Index for efficient filtering
    },
    currentCallId: {
      type: String,
      sparse: true,
      index: true, // Index for efficient lookup of creators in calls
    },
    earningsCoins: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  {
    timestamps: true,
  }
);

export const Creator = mongoose.model<ICreator>('Creator', creatorSchema);
