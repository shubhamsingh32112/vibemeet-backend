import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import * as admin from 'firebase-admin';
import dotenv from 'dotenv';

dotenv.config();

const projectId = process.env.FIREBASE_PROJECT_ID;
const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');
const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
const explicitBucket = process.env.FIREBASE_STORAGE_BUCKET;

if (!projectId || !privateKey || !clientEmail) {
  throw new Error(
    'Missing Firebase Admin env vars. Required: FIREBASE_PROJECT_ID, FIREBASE_PRIVATE_KEY, FIREBASE_CLIENT_EMAIL',
  );
}

const storageBucket =
  explicitBucket && explicitBucket.trim().length > 0
    ? explicitBucket.trim()
    : `${projectId}.firebasestorage.app`;

admin.initializeApp({
  credential: admin.credential.cert({
    projectId,
    privateKey,
    clientEmail,
  }),
  storageBucket,
});

const bucket = admin.storage().bucket(storageBucket);

type Gender = 'male' | 'female';

async function uploadPresetGroup(gender: Gender): Promise<void> {
  const localDir = path.resolve(
    __dirname,
    '..',
    '..',
    '..',
    'frontend',
    'lib',
    'assets',
    gender,
  );

  const files = (await fs.readdir(localDir))
    .filter((name) => name.toLowerCase().endsWith('.png'))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  if (files.length === 0) {
    console.log(`⚠️ No ${gender} preset avatars found in ${localDir}`);
    return;
  }

  console.log(`\n📁 Uploading ${files.length} ${gender} avatars from ${localDir}`);

  for (const fileName of files) {
    const localFile = path.join(localDir, fileName);
    const remotePath = `avatars/presets/${gender}/${fileName}`;
    const token = crypto.randomUUID();

    await bucket.upload(localFile, {
      destination: remotePath,
      metadata: {
        contentType: 'image/png',
        cacheControl: 'public,max-age=31536000,immutable',
        metadata: {
          firebaseStorageDownloadTokens: token,
          source: 'preset_avatar_seed',
          gender,
          avatarName: fileName,
        },
      },
    });

    const downloadUrl = `https://firebasestorage.googleapis.com/v0/b/${encodeURIComponent(
      storageBucket,
    )}/o/${encodeURIComponent(remotePath)}?alt=media&token=${token}`;
    console.log(`✅ ${gender}/${fileName} -> ${downloadUrl}`);
  }
}

async function main(): Promise<void> {
  console.log('───────────────────────────────────────────────────────');
  console.log('🖼️  Uploading preset avatars to Firebase Storage');
  console.log(`📦 Bucket: ${storageBucket}`);
  console.log('───────────────────────────────────────────────────────');

  await uploadPresetGroup('male');
  await uploadPresetGroup('female');

  console.log('\n🎉 Preset avatar upload complete.');
  console.log('   They are available under: avatars/presets/{male|female}/*.png');
}

main().catch((error) => {
  console.error('❌ Failed to upload preset avatars:', error);
  process.exit(1);
});
