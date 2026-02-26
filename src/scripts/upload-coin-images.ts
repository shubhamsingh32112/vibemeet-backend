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
const localCoinDir = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  'frontend',
  'lib',
  'assets',
  'coinsvg',
);

function toOrdinal(fileName: string): number | null {
  const match = fileName.match(/^(\d+)\.png$/i);
  if (!match) return null;
  return Number.parseInt(match[1]!, 10);
}

function makeDownloadUrl(remotePath: string, token: string): string {
  return `https://firebasestorage.googleapis.com/v0/b/${encodeURIComponent(
    storageBucket,
  )}/o/${encodeURIComponent(remotePath)}?alt=media&token=${token}`;
}

async function main(): Promise<void> {
  console.log('───────────────────────────────────────────────────────');
  console.log('🪙 Uploading wallet coin PNGs to Firebase Storage');
  console.log(`📦 Bucket: ${storageBucket}`);
  console.log(`📁 Source: ${localCoinDir}`);
  console.log('───────────────────────────────────────────────────────');

  const files = (await fs.readdir(localCoinDir))
    .map((fileName) => ({ fileName, ordinal: toOrdinal(fileName) }))
    .filter((entry) => entry.ordinal != null)
    .sort((a, b) => (a.ordinal as number) - (b.ordinal as number));

  if (files.length === 0) {
    throw new Error(`No numbered png files found in ${localCoinDir} (expected 1.png..9.png)`);
  }

  for (const { fileName, ordinal } of files) {
    const localFile = path.join(localCoinDir, fileName);
    const remotePath = `wallet/coins/${ordinal}.png`;
    const token = crypto.randomUUID();

    await bucket.upload(localFile, {
      destination: remotePath,
      metadata: {
        contentType: 'image/png',
        cacheControl: 'public,max-age=31536000,immutable',
        metadata: {
          firebaseStorageDownloadTokens: token,
          source: 'wallet_coin_seed',
          ordinal: String(ordinal),
        },
      },
    });

    const downloadUrl = makeDownloadUrl(remotePath, token);
    console.log(`✅ ${fileName} -> ${downloadUrl}`);
  }

  console.log('\n🎉 Coin image upload complete.');
  console.log('   They are available under: wallet/coins/{1..9}.png');
}

main().catch((error) => {
  console.error('❌ Failed to upload wallet coin images:', error);
  process.exit(1);
});
