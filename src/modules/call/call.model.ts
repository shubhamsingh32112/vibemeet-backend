import mongoose, { Document, Schema } from 'mongoose';

export type CallStatus = 'initiated' | 'ringing' | 'accepted' | 'rejected' | 'ended';

export interface ICall extends Document {
  _id: mongoose.Types.ObjectId;
  callId: string; // Unique call identifier
  channelName: string; // Agora channel name
  callerUserId: mongoose.Types.ObjectId; // End user who initiated
  creatorUserId: mongoose.Types.ObjectId; // Creator receiving the call
  status: CallStatus;
  token?: string; // Agora token (generated when accepted)
  tokenExpiry?: Date; // Token expiry time
  acceptedAt?: Date; // When call was accepted (video call started)
  endedAt?: Date; // When call ended
  duration?: number; // Call duration in seconds (endedAt - acceptedAt)
  createdAt: Date;
  updatedAt: Date;
}

const callSchema = new Schema<ICall>(
  {
    callId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    channelName: {
      type: String,
      required: true,
      index: true,
    },
    callerUserId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    creatorUserId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ['initiated', 'ringing', 'accepted', 'rejected', 'ended'],
      default: 'initiated',
      required: true,
      index: true,
    },
    token: {
      type: String,
      sparse: true,
    },
    tokenExpiry: {
      type: Date,
      sparse: true,
    },
    acceptedAt: {
      type: Date,
      sparse: true,
    },
    endedAt: {
      type: Date,
      sparse: true,
    },
    duration: {
      type: Number,
      sparse: true,
      min: 0,
    },
  },
  {
    timestamps: true,
  }
);

// Index for finding active calls for a creator
callSchema.index({ creatorUserId: 1, status: 1 });
callSchema.index({ callerUserId: 1, status: 1 });

export const Call = mongoose.model<ICall>('Call', callSchema);
