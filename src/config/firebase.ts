import * as admin from 'firebase-admin';
import { logInfo, logError } from '../utils/logger';

let firebaseApp: admin.app.App | null = null;

export const initializeFirebase = (): void => {
  if (firebaseApp) {
    return; // Already initialized
  }

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;

  if (!projectId || !privateKey || !clientEmail) {
    throw new Error('Firebase Admin credentials are missing in environment variables');
  }

  try {
    firebaseApp = admin.initializeApp({
      credential: admin.credential.cert({
        projectId,
        privateKey,
        clientEmail,
      }),
    });
    logInfo('Firebase Admin initialized successfully', {
      projectId,
    });
  } catch (error) {
    logError('Firebase Admin initialization error', error, {
      projectId: projectId || 'missing',
    });
    throw error;
  }
};

export const getFirebaseAdmin = (): admin.app.App => {
  if (!firebaseApp) {
    throw new Error('Firebase Admin not initialized. Call initializeFirebase() first.');
  }
  return firebaseApp;
};
