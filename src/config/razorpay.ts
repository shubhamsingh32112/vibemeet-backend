import Razorpay from 'razorpay';

let razorpayInstance: InstanceType<typeof Razorpay> | null = null;

/**
 * Initialize and return the Razorpay instance.
 * Requires RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in .env
 */
export function getRazorpayInstance(): InstanceType<typeof Razorpay> {
  if (razorpayInstance) return razorpayInstance;

  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;

  if (!keyId || !keySecret) {
    throw new Error(
      '❌ RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET must be set in .env'
    );
  }

  razorpayInstance = new Razorpay({
    key_id: keyId,
    key_secret: keySecret,
  });

  console.log('✅ [RAZORPAY] Instance initialized');
  return razorpayInstance;
}

/**
 * Check if Razorpay credentials are configured
 */
export function isRazorpayConfigured(): boolean {
  return !!(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
}
