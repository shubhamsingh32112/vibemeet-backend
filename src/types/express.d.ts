import 'express';

declare global {
  namespace Express {
    interface Request {
      auth?: {
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
