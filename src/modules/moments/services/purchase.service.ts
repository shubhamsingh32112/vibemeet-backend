import mongoose from 'mongoose';
import type { PresentationDTO } from '../dto/moment.dto';

export class MomentsPremiumRequiredError extends Error {
  readonly code = 'MOMENTS_PREMIUM_REQUIRED';

  constructor() {
    super('Moments Premium subscription required');
    this.name = 'MomentsPremiumRequiredError';
  }
}

/** @deprecated Coin purchases removed — use Moments Premium subscription. */
export async function purchaseMoment(_input: {
  userId: mongoose.Types.ObjectId;
  momentId: string;
  transactionId?: string;
}): Promise<PresentationDTO> {
  throw new MomentsPremiumRequiredError();
}
