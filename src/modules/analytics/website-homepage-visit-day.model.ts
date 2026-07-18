import mongoose, { Document, Schema } from 'mongoose';

/** One row per anonymous visitor per IST calendar day (homepage only). */
export interface IWebsiteHomepageVisitDay extends Document {
  _id: mongoose.Types.ObjectId;
  visitorId: string;
  /** IST calendar date `YYYY-MM-DD`. */
  day: string;
  firstHitAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const websiteHomepageVisitDaySchema = new Schema<IWebsiteHomepageVisitDay>(
  {
    visitorId: {
      type: String,
      required: true,
      trim: true,
      maxlength: 64,
      index: true,
    },
    day: {
      type: String,
      required: true,
      trim: true,
      match: /^\d{4}-\d{2}-\d{2}$/,
      index: true,
    },
    firstHitAt: {
      type: Date,
      required: true,
    },
  },
  { timestamps: true },
);

websiteHomepageVisitDaySchema.index({ visitorId: 1, day: 1 }, { unique: true });
websiteHomepageVisitDaySchema.index({ day: 1, visitorId: 1 });

export const WebsiteHomepageVisitDay = mongoose.model<IWebsiteHomepageVisitDay>(
  'WebsiteHomepageVisitDay',
  websiteHomepageVisitDaySchema,
);
