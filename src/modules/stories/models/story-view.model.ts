import mongoose, { Document, Schema } from 'mongoose';

export interface IStoryView extends Document {
  _id: mongoose.Types.ObjectId;
  storyId: mongoose.Types.ObjectId;
  viewerUserId: mongoose.Types.ObjectId;
  viewedAt: Date;
}

const storyViewSchema = new Schema<IStoryView>(
  {
    storyId: { type: Schema.Types.ObjectId, ref: 'CreatorStory', required: true },
    viewerUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    viewedAt: { type: Date, default: () => new Date() },
  },
  { timestamps: false },
);

storyViewSchema.index({ storyId: 1, viewerUserId: 1 }, { unique: true });
storyViewSchema.index({ storyId: 1, viewedAt: -1 });

export const StoryView = mongoose.model<IStoryView>('StoryView', storyViewSchema);
