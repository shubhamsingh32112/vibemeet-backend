import { z } from 'zod';

/**
 * CANONICAL DTOs & Zod schemas used by legacy controllers.
 *
 * These are intentionally minimal and model only the fields that are
 * actually used by the current controllers.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Creator DTOs
// ─────────────────────────────────────────────────────────────────────────────

export const creatorSummarySchema = z.object({
  id: z.string(),
  userId: z.string().nullable().optional(),
  firebaseUid: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  about: z.string().nullable().optional(),
  photo: z.string().nullable().optional(),
  categories: z.array(z.string()).optional(),
  price: z.number().nullable().optional(),
  isOnline: z.boolean().nullable().optional(),
  availability: z.string().optional(),
  isFavorite: z.boolean().optional(),
  createdAt: z.string().nullable().optional(),
  updatedAt: z.string().nullable().optional(),
});

export const creatorListResponseDtoSchema = z.object({
  creators: z.array(creatorSummarySchema),
});

export type CreatorListResponseDto = z.infer<typeof creatorListResponseDtoSchema>;

export const creatorProfileResponseDtoSchema = z.object({
  creator: creatorSummarySchema,
});

export type CreatorProfileResponseDto = z.infer<typeof creatorProfileResponseDtoSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Payment DTOs
// ─────────────────────────────────────────────────────────────────────────────

export const paymentVerifyResponseDtoSchema = z.object({
  status: z.enum(['verified', 'already_verified']),
  message: z.string(),
  transactionId: z.string().optional(),
  coins: z.number(),
  coinsAdded: z.number(),
});

export type PaymentVerifyResponseDto = z.infer<typeof paymentVerifyResponseDtoSchema>;

export const walletPackageSchema = z.object({
  coins: z.number(),
  priceInr: z.number(),
  oldPriceInr: z.number().nullable().optional(),
  badge: z.string().nullable().optional(),
  sortOrder: z.number().nullable().optional(),
});

export const walletPackagesResponseDtoSchema = z.object({
  pricingTier: z.string(),
  hasPurchasedCoinPackage: z.boolean(),
  packages: z.array(walletPackageSchema),
  pricingUpdatedAt: z.string(),
});

export type WalletPackagesResponseDto = z.infer<typeof walletPackagesResponseDtoSchema>;

