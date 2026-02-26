/**
 * Seed Admin User Script
 *
 * Creates a default admin user in MongoDB (NO Firebase Auth needed).
 * Run: npx tsx src/scripts/seed-admin.ts
 *
 * Default credentials:
 *   Email:    admin@matchvibe.com
 *   Password: admin@matchvibe
 */

import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import { User } from '../modules/user/user.model';

const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'admin@matchvibe.com').trim();
const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || 'admin@matchvibe').trim();

async function seedAdmin() {
  console.log('🔧 Seed Admin Script');
  console.log('====================\n');

  // 1. Connect to MongoDB
  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) {
    console.error('❌ MONGO_URI missing in .env');
    process.exit(1);
  }
  await mongoose.connect(mongoUri);
  console.log('✅ MongoDB connected\n');

  // 2. Create or update admin user in MongoDB (no Firebase required)
  let dbUser = await User.findOne({ email: ADMIN_EMAIL, role: 'admin' });

  if (dbUser) {
    console.log(`ℹ️  Admin user already exists in MongoDB`);
    console.log(`   ID: ${dbUser._id}`);
  } else {
    dbUser = await User.create({
      firebaseUid: `admin_${Date.now()}`,
      email: ADMIN_EMAIL,
      role: 'admin',
      categories: ['admin'],
      coins: 0,
      freeTextUsed: 0,
    });
    console.log(`✅ Admin user created in MongoDB`);
    console.log(`   ID: ${dbUser._id}`);
  }

  console.log('\n====================');
  console.log('🎉 Admin user ready!\n');
  console.log('📧 Email:    ' + ADMIN_EMAIL);
  console.log('🔑 Password: ' + ADMIN_PASSWORD);
  console.log('\n⚠️  Change the password in your .env after first login!');
  console.log('====================\n');

  await mongoose.disconnect();
  process.exit(0);
}

seedAdmin().catch((error) => {
  console.error('❌ Seed script failed:', error);
  process.exit(1);
});
