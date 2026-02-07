/**
 * Seed Admin User Script
 * 
 * Creates a default admin user in Firebase Auth + MongoDB.
 * Run: npx tsx src/scripts/seed-admin.ts
 * 
 * Default credentials:
 *   Email:    admin@eazytalks.com
 *   Password: Admin@123456
 */

import dotenv from 'dotenv';
dotenv.config();

import * as admin from 'firebase-admin';
import mongoose from 'mongoose';
import { User } from '../modules/user/user.model';

const ADMIN_EMAIL = 'admin@matchvibe.com';
const ADMIN_PASSWORD = 'admin@matchvibe';

async function seedAdmin() {
  console.log('🔧 Seed Admin Script');
  console.log('====================\n');

  // 1. Initialize Firebase Admin
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;

  if (!projectId || !privateKey || !clientEmail) {
    console.error('❌ Firebase Admin credentials missing in .env');
    process.exit(1);
  }

  admin.initializeApp({
    credential: admin.credential.cert({ projectId, privateKey, clientEmail }),
  });
  console.log('✅ Firebase Admin initialized');

  // 2. Connect to MongoDB
  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) {
    console.error('❌ MONGO_URI missing in .env');
    process.exit(1);
  }
  await mongoose.connect(mongoUri);
  console.log('✅ MongoDB connected\n');

  // 3. Create or get Firebase Auth user
  let firebaseUser: admin.auth.UserRecord;
  try {
    firebaseUser = await admin.auth().getUserByEmail(ADMIN_EMAIL);
    console.log(`ℹ️  Firebase user already exists: ${firebaseUser.uid}`);
  } catch (error: any) {
    if (error.code === 'auth/user-not-found') {
      firebaseUser = await admin.auth().createUser({
        email: ADMIN_EMAIL,
        password: ADMIN_PASSWORD,
        emailVerified: true,
        displayName: 'Admin',
      });
      console.log(`✅ Firebase user created: ${firebaseUser.uid}`);
    } else {
      throw error;
    }
  }

  // 4. Create or update MongoDB user with admin role
  let dbUser = await User.findOne({ firebaseUid: firebaseUser.uid });
  if (dbUser) {
    if (dbUser.role !== 'admin') {
      dbUser.role = 'admin';
      await dbUser.save();
      console.log(`✅ MongoDB user updated to admin role`);
    } else {
      console.log(`ℹ️  MongoDB user already has admin role`);
    }
  } else {
    dbUser = await User.create({
      firebaseUid: firebaseUser.uid,
      email: ADMIN_EMAIL,
      role: 'admin',
      categories: ['admin'],
      coins: 0,
      freeTextUsed: 0,
    });
    console.log(`✅ MongoDB admin user created`);
  }

  console.log('\n====================');
  console.log('🎉 Admin user ready!\n');
  console.log('📧 Email:    ' + ADMIN_EMAIL);
  console.log('🔑 Password: ' + ADMIN_PASSWORD);
  console.log('\n⚠️  Change the password after first login!');
  console.log('====================\n');

  await mongoose.disconnect();
  process.exit(0);
}

seedAdmin().catch((error) => {
  console.error('❌ Seed script failed:', error);
  process.exit(1);
});
