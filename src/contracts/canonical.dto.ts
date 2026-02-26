import { z } from 'zod';

const isoDateString = z.string().datetime().or(z.string());

export const userProfileDtoSchema = z.object({
  id: z.string(),
  firebaseUid: z.string().optional(),
  role: z.enum(['user', 'creator', 'admin']),
  email: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  gender: z.enum(['male', 'female', 'other']).nullable().optional(),
  username: z.string().nullable().optional(),
  avatar: z.string().nullable().optional(),
  categories: z.array(z.string()).default([]),
  coins: z.number(),
  welcomeBonusClaimed: z.boolean().optional(),
  usernameChangeCount: z.number().optional(),
  blockedCreatorCount: z.number().optional(),
  createdAt: isoDateString.optional(),
  updatedAt: isoDateString.optional(),
});

export const creatorProfileDtoSchema = z.object({
  id: z.string(),
  userId: z.string().nullable().optional(),
  firebaseUid: z.string().nullable().optional(),
  name: z.string(),
  about: z.string().nullable().optional(),
  photo: z.string().nullable().optional(),
  categories: z.array(z.string()).default([]),
  price: z.number(),
  isOnline: z.boolean().optional(),
  availability: z.enum(['online', 'busy']).optional(),
  isFavorite: z.boolean().optional(),
  createdAt: isoDateString.optional(),
  updatedAt: isoDateString.optional(),
});

export const authResponseDtoSchema = z.object({
  session: z.object({
    authenticated: z.boolean(),
    needsOnboarding: z.boolean(),
  }),
  user: userProfileDtoSchema,
  creator: creatorProfileDtoSchema.nullable(),
  adminToken: z.string().optional(),
});

export const walletPackageDtoSchema = z.object({
  coins: z.number(),
  priceInr: z.number(),
  oldPriceInr: z.number().optional(),
  badge: z.string().optional(),
  sortOrder: z.number(),
});

export const walletPackagesResponseDtoSchema = z.object({
  pricingTier: z.enum(['tier1', 'tier2']),
  hasPurchasedCoinPackage: z.boolean(),
  packages: z.array(walletPackageDtoSchema),
  pricingUpdatedAt: isoDateString,
});

export const paymentVerifyResponseDtoSchema = z.object({
  status: z.enum(['verified', 'already_verified']),
  message: z.string(),
  transactionId: z.string().optional(),
  coins: z.number(),
  coinsAdded: z.number(),
});

export const creatorListResponseDtoSchema = z.object({
  creators: z.array(creatorProfileDtoSchema),
});

export const creatorProfileResponseDtoSchema = z.object({
  creator: creatorProfileDtoSchema,
});

export const userProfileResponseDtoSchema = z.object({
  user: userProfileDtoSchema,
  creator: creatorProfileDtoSchema.nullable(),
});

export type AuthResponseDto = z.infer<typeof authResponseDtoSchema>;
export type UserProfileResponseDto = z.infer<typeof userProfileResponseDtoSchema>;
export type CreatorListResponseDto = z.infer<typeof creatorListResponseDtoSchema>;
export type CreatorProfileResponseDto = z.infer<typeof creatorProfileResponseDtoSchema>;
export type WalletPackagesResponseDto = z.infer<typeof walletPackagesResponseDtoSchema>;
export type PaymentVerifyResponseDto = z.infer<typeof paymentVerifyResponseDtoSchema>;

