import mongoose, { Document, Schema } from 'mongoose';
import { CREATOR_GALLERY_MAX_IMAGES } from './creator-gallery.constants';
import { CREATOR_LOCATION_MAX_LEN } from './creator-location.util';

export interface ICreatorGalleryImage {
  id: string;
  url: string;
  storagePath: string;
  position: number;
  createdAt: Date;
}

export interface ICreator extends Document {
  _id: mongoose.Types.ObjectId;
  name: string;
  about: string;
  photo: string; // URL or path to photo
  galleryImages: ICreatorGalleryImage[];
  userId: mongoose.Types.ObjectId; // Reference to User document (REQUIRED - creator cannot exist without user)
  categories: string[]; // Array of category names (optional)
  price: number; // Coins per minute — must be 60, 90, or 120 (set by admin or assigned agent)
  age?: number; // Creator's age (optional)
  /** Display location (e.g. city or region). */
  location?: string;
  isOnline: boolean; // Online/offline status for creators
  currentCallId?: string; // Current active call ID (locks creator from accepting other calls)
  earningsCoins: number; // Total creator earnings from video calls
  /** Agent who recruited/manages this creator (set when agent accepts an application). */
  assignedAgentId?: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const creatorGalleryImageSchema = new Schema<ICreatorGalleryImage>(
  {
    id: {
      type: String,
      required: true,
      trim: true,
    },
    url: {
      type: String,
      required: true,
      trim: true,
    },
    storagePath: {
      type: String,
      required: true,
      trim: true,
    },
    position: {
      type: Number,
      required: true,
      min: 0,
    },
    createdAt: {
      type: Date,
      required: true,
      default: Date.now,
    },
  },
  { _id: false }
);

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
    galleryImages: {
      type: [creatorGalleryImageSchema],
      default: [],
      validate: {
        validator: (images: ICreatorGalleryImage[]) =>
          Array.isArray(images) && images.length <= CREATOR_GALLERY_MAX_IMAGES,
        message: `galleryImages cannot exceed ${CREATOR_GALLERY_MAX_IMAGES} items`,
      },
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
    age: {
      type: Number,
      sparse: true,
      min: 18,
      max: 100,
    },
    location: {
      type: String,
      trim: true,
      maxlength: CREATOR_LOCATION_MAX_LEN,
      sparse: true,
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
    assignedAgentId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      sparse: true,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

creatorSchema.index({ assignedAgentId: 1, updatedAt: -1 });

export const Creator = mongoose.model<ICreator>('Creator', creatorSchema);
