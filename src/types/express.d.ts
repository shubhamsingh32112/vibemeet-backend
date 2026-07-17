import 'express';

declare global {
  namespace Express {
    interface Request {
      auth?: {
        firebaseUid: string;
        phone?: string;
        email?: string;
      };
      /** Firebase claims already verified by the global rate-limit identity middleware. */
      firebaseVerifiedAuth?: {
        firebaseUid: string;
        phone?: string;
        email?: string;
      };
      rateLimit?: {
        resetTime?: Date;
      };
    }
  }
}

export {};
