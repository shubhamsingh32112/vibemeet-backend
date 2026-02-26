const DISALLOWED_SECRET_VALUES = new Set([
  'admin-secret-change-me',
  'checkout-session-secret-change-me',
  'admin@matchvibe.com',
  'admin@matchvibe',
]);

const trim = (value: string | undefined): string => (value || '').trim();

const isWeakSecret = (value: string): boolean => value.length < 16 || DISALLOWED_SECRET_VALUES.has(value);

const assertRequired = (name: string): void => {
  const value = trim(process.env[name]);
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
};

export const requireEnv = (name: string): string => {
  assertRequired(name);
  return trim(process.env[name]);
};

export const validateRuntimeEnv = (): void => {
  const nodeEnv = trim(process.env.NODE_ENV) || 'development';
  if (nodeEnv !== 'production') {
    return;
  }

  const requiredInProd = [
    'MONGO_URI',
    'JWT_SECRET',
    'CHECKOUT_SESSION_SECRET',
    'ADMIN_EMAIL',
    'ADMIN_PASSWORD',
    'FIREBASE_PROJECT_ID',
    'FIREBASE_CLIENT_EMAIL',
    'FIREBASE_PRIVATE_KEY',
    'RAZORPAY_KEY_ID',
    'RAZORPAY_KEY_SECRET',
    'STREAM_API_KEY',
    'STREAM_API_SECRET',
  ];

  requiredInProd.forEach(assertRequired);

  const weakValues: string[] = [];
  const jwtSecret = requireEnv('JWT_SECRET');
  const checkoutSecret = requireEnv('CHECKOUT_SESSION_SECRET');
  const adminPassword = requireEnv('ADMIN_PASSWORD');
  const adminEmail = requireEnv('ADMIN_EMAIL');

  if (isWeakSecret(jwtSecret)) weakValues.push('JWT_SECRET');
  if (isWeakSecret(checkoutSecret)) weakValues.push('CHECKOUT_SESSION_SECRET');
  if (isWeakSecret(adminPassword)) weakValues.push('ADMIN_PASSWORD');
  if (DISALLOWED_SECRET_VALUES.has(adminEmail)) weakValues.push('ADMIN_EMAIL');

  if (weakValues.length > 0) {
    throw new Error(`Weak or insecure production secrets detected: ${weakValues.join(', ')}`);
  }
};

