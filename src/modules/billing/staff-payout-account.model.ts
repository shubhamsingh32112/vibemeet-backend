import mongoose, { Document, Schema } from 'mongoose';

export interface IStaffPayoutAccount extends Document {
  staffUserId: mongoose.Types.ObjectId;
  accountHolderName: string;
  accountNumber?: string;
  ifsc?: string;
  upi?: string;
  phone?: string;
  createdAt: Date;
  updatedAt: Date;
}

const staffPayoutAccountSchema = new Schema<IStaffPayoutAccount>(
  {
    staffUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },
    accountHolderName: { type: String, required: true, trim: true, maxlength: 120 },
    accountNumber: { type: String, trim: true, maxlength: 32 },
    ifsc: { type: String, trim: true, uppercase: true, maxlength: 11 },
    upi: { type: String, trim: true, lowercase: true, maxlength: 120 },
    phone: { type: String, trim: true, maxlength: 20 },
  },
  { timestamps: true },
);

export const StaffPayoutAccount = mongoose.model<IStaffPayoutAccount>(
  'StaffPayoutAccount',
  staffPayoutAccountSchema,
);
