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
const ringtoneDir = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  'frontend',
  'lib',
  'assets',
  'ringtone',
);
const canonicalRemotePath = 'ringtone/incoming_creator.mp3';

function contentTypeFor(fileName: string): string {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.wav')) return 'audio/wav';
  if (lower.endsWith('.m4a')) return 'audio/mp4';
  return 'audio/mpeg';
}

function makeDownloadUrl(remotePath: string, token: string): string {
  return `https://firebasestorage.googleapis.com/v0/b/${encodeURIComponent(
    storageBucket,
  )}/o/${encodeURIComponent(remotePath)}?alt=media&token=${token}`;
}

async function uploadOne(localFile: string, remotePath: string): Promise<string> {
  const token = crypto.randomUUID();
  await bucket.upload(localFile, {
    destination: remotePath,
    metadata: {
      contentType: contentTypeFor(localFile),
      cacheControl: 'public,max-age=31536000,immutable',
      metadata: {
        firebaseStorageDownloadTokens: token,
        source: 'ringtone_seed',
      },
    },
  });
  return makeDownloadUrl(remotePath, token);
}

async function main(): Promise<void> {
  console.log('───────────────────────────────────────────────────────');
  console.log('🎵 Uploading ringtone files to Firebase Storage');
  console.log(`📦 Bucket: ${storageBucket}`);
  console.log(`📁 Source: ${ringtoneDir}`);
  console.log('───────────────────────────────────────────────────────');

  const files = (await fs.readdir(ringtoneDir))
    .filter((name) => /\.(mp3|wav|m4a)$/i.test(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  if (files.length === 0) {
    throw new Error(`No ringtone files found in ${ringtoneDir}`);
  }

  let preferredLocalFile: string | null = null;

  for (const fileName of files) {
    const localFile = path.join(ringtoneDir, fileName);
    const remotePath = `ringtone/${fileName}`;
    const downloadUrl = await uploadOne(localFile, remotePath);
    console.log(`✅ ${fileName} -> ${downloadUrl}`);

    if (preferredLocalFile == null && fileName.toLowerCase().endsWith('.mp3')) {
      preferredLocalFile = localFile;
    }
  }

  // Also publish a stable object path used by the mobile app.
  const canonicalSource = preferredLocalFile ?? path.join(ringtoneDir, files[0]!);
  const canonicalDownloadUrl = await uploadOne(canonicalSource, canonicalRemotePath);
  console.log(`\n✅ Canonical ringtone -> ${canonicalDownloadUrl}`);
  console.log(`   Path: ${canonicalRemotePath}`);
}

main().catch((error) => {
  console.error('❌ Failed to upload ringtone files:', error);
  process.exit(1);
});
