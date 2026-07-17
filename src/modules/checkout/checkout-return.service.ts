import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import type { Request, Response } from 'express';
import { CoinTransaction } from '../user/coin-transaction.model';
import { User } from '../user/user.model';
import {
  CheckoutContext,
  type CheckoutOrigin,
  type CheckoutProduct,
  type CheckoutStatus,
} from './checkout-context.model';

const MAX_RETURN_TO_BYTES = 2048;
const CONTEXT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const ENCODED_SEPARATOR = /%(?:2f|5c|25(?:2f|5c))/i;

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

export interface CheckoutNavigationClaims {
  checkoutId?: string;
  checkoutOrigin?: CheckoutOrigin;
  returnTo?: string;
}

export interface ReturnTarget {
  kind: CheckoutOrigin;
  url: string;
}

export class InvalidReturnToError extends Error {
  constructor() {
    super('Invalid returnTo');
  }
}

export function validateReturnTo(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_RETURN_TO_BYTES) {
    throw new InvalidReturnToError();
  }
  if (
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('\\') ||
    hasControlCharacters(value) ||
    ENCODED_SEPARATOR.test(value)
  ) {
    throw new InvalidReturnToError();
  }

  let parsed: URL;
  try {
    parsed = new URL(value, 'https://return.invalid');
  } catch {
    throw new InvalidReturnToError();
  }
  if (parsed.origin !== 'https://return.invalid') throw new InvalidReturnToError();

  const normalizedPath = parsed.pathname.replace(/\/{2,}/g, '/').toLowerCase();
  if (
    normalizedPath === '/payment/return' ||
    normalizedPath.startsWith('/payment/return/') ||
    normalizedPath.includes('checkout')
  ) {
    throw new InvalidReturnToError();
  }
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

export function resolveCheckoutOrigin(value: unknown): CheckoutOrigin {
  if (value === undefined || value === null || value === '') return 'app';
  if (value !== 'app' && value !== 'web') throw new Error('Invalid checkoutOrigin');
  return value;
}

export function recoverSignedNavigationClaims(
  checkoutToken: string,
): CheckoutNavigationClaims | null {
  try {
    const secret = (
      process.env.CHECKOUT_SESSION_SECRET ||
      process.env.JWT_SECRET ||
      'checkout-session-secret-change-me'
    ).trim();
    const decoded = jwt.verify(checkoutToken, secret, { ignoreExpiration: true });
    if (!decoded || typeof decoded === 'string') return null;
    const checkoutOrigin = resolveCheckoutOrigin(decoded.checkoutOrigin);
    const returnTo = validateReturnTo(decoded.returnTo);
    const checkoutId =
      typeof decoded.checkoutId === 'string' && /^[A-Za-z0-9_-]{32}$/.test(decoded.checkoutId)
        ? decoded.checkoutId
        : undefined;
    if (checkoutOrigin === 'web' && (!returnTo || !checkoutId)) return null;
    return { checkoutOrigin, returnTo, checkoutId };
  } catch {
    return null;
  }
}

export async function createCheckoutContext(input: {
  userId: string | mongoose.Types.ObjectId;
  product: CheckoutProduct;
  checkoutOrigin: unknown;
  returnTo: unknown;
}): Promise<Required<Pick<CheckoutNavigationClaims, 'checkoutId' | 'checkoutOrigin'>> & { returnTo?: string }> {
  const checkoutOrigin = resolveCheckoutOrigin(input.checkoutOrigin);
  const returnTo = validateReturnTo(input.returnTo);
  if (checkoutOrigin === 'web' && !returnTo) throw new InvalidReturnToError();

  const checkoutId = crypto.randomBytes(24).toString('base64url');
  await CheckoutContext.create({
    checkoutId,
    userId: input.userId,
    product: input.product,
    origin: checkoutOrigin,
    returnTo,
    status: 'created',
    expiresAt: new Date(Date.now() + CONTEXT_RETENTION_MS),
  });
  return { checkoutId, checkoutOrigin, returnTo };
}

function webBaseUrl(): string {
  const value = process.env.WEB_APP_BASE_URL?.trim().replace(/\/$/, '');
  if (!value) {
    if (process.env.NODE_ENV === 'production') throw new Error('WEB_APP_BASE_URL is required');
    return 'http://localhost:5173';
  }
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.pathname !== '/') {
    throw new Error('WEB_APP_BASE_URL must be an absolute origin');
  }
  return parsed.origin;
}

export function buildReturnTarget(
  claims: CheckoutNavigationClaims,
  status: Exclude<CheckoutStatus, 'created'>,
  buildLegacyAppUrl: (status: 'success' | 'failed', reason?: string) => string,
  reason?: string,
): ReturnTarget {
  if (
    claims.checkoutOrigin === 'web' &&
    claims.checkoutId &&
    validateReturnTo(claims.returnTo)
  ) {
    const query = new URLSearchParams({ checkoutId: claims.checkoutId, status });
    if (reason) query.set('reason', reason);
    return { kind: 'web', url: `${webBaseUrl()}/payment/return?${query.toString()}` };
  }
  return {
    kind: 'app',
    url: buildLegacyAppUrl(status === 'success' ? 'success' : 'failed', reason),
  };
}

export function buildNeutralReturnTargets(
  claims: CheckoutNavigationClaims,
  buildLegacyAppUrl: (status: 'success' | 'failed', reason?: string) => string,
): { cancelled: ReturnTarget; failed: ReturnTarget } {
  return {
    cancelled: buildReturnTarget(claims, 'cancelled', buildLegacyAppUrl, 'cancelled'),
    failed: buildReturnTarget(claims, 'failed', buildLegacyAppUrl, 'payment_failed'),
  };
}

export async function attachCheckoutOrder(checkoutId: string | undefined, orderId: string): Promise<void> {
  if (!checkoutId) return;
  await CheckoutContext.updateOne(
    { checkoutId, status: 'created' },
    { $set: { orderId, status: 'pending' } },
  );
}

export async function recordCheckoutResult(
  checkoutId: string | undefined,
  status: Extract<CheckoutStatus, 'success' | 'failed' | 'cancelled'>,
  result?: Record<string, unknown>,
): Promise<void> {
  if (!checkoutId) return;
  await CheckoutContext.updateOne(
    { checkoutId },
    { $set: { status, ...(result ? { result } : {}) } },
  );
}

export const getCheckoutStatus = async (req: Request, res: Response): Promise<void> => {
  if (!req.auth) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }
  const checkoutId = String(req.params.checkoutId || '');
  if (!/^[A-Za-z0-9_-]{32}$/.test(checkoutId)) {
    res.status(400).json({ success: false, error: 'Invalid checkoutId' });
    return;
  }
  const user = await User.findOne({ firebaseUid: req.auth.firebaseUid }).select('_id');
  if (!user) {
    res.status(404).json({ success: false, error: 'User not found' });
    return;
  }
  const context = await CheckoutContext.findOne({ checkoutId, userId: user._id }).lean();
  if (!context) {
    res.status(404).json({ success: false, error: 'Checkout not found' });
    return;
  }

  let status = context.status;
  if (context.orderId && status !== 'success') {
    const transaction = await CoinTransaction.findOne({
      userId: user._id,
      $or: [
        { paymentGatewayOrderId: context.orderId },
        { paymentGatewayTransactionId: context.orderId },
        { transactionId: { $in: [`pay_${context.orderId}`, `razorpay_${context.orderId}`, `vip_${context.orderId}`, `moments_premium_${context.orderId}`] } },
      ],
    }).select('status').lean();
    if (transaction?.status === 'completed') status = 'success';
    if (transaction?.status === 'failed') status = 'failed';
    if (status !== context.status) {
      await CheckoutContext.updateOne({ _id: context._id }, { $set: { status } });
    }
  }

  res.json({
    success: true,
    data: {
      checkoutId: context.checkoutId,
      product: context.product,
      status,
      returnTo: context.returnTo,
      result: status === 'success' ? context.result : undefined,
      updatedAt: context.updatedAt,
    },
  });
};

export const recordHostedCheckoutResult = async (req: Request, res: Response): Promise<void> => {
  const { checkoutToken, status } = req.body as {
    checkoutToken?: unknown;
    status?: unknown;
  };
  if (
    typeof checkoutToken !== 'string' ||
    (status !== 'cancelled' && status !== 'failed')
  ) {
    res.status(400).json({ success: false, error: 'Invalid checkout result' });
    return;
  }
  try {
    const secret = (
      process.env.CHECKOUT_SESSION_SECRET ||
      process.env.JWT_SECRET ||
      'checkout-session-secret-change-me'
    ).trim();
    const decoded = jwt.verify(checkoutToken, secret);
    if (
      !decoded ||
      typeof decoded === 'string' ||
      typeof decoded.checkoutId !== 'string'
    ) {
      throw new Error('invalid');
    }
    await CheckoutContext.updateOne(
      { checkoutId: decoded.checkoutId, status: { $in: ['created', 'pending'] } },
      { $set: { status } },
    );
    res.json({ success: true, data: { recorded: true } });
  } catch {
    res.status(401).json({ success: false, error: 'Invalid or expired checkout token' });
  }
};
