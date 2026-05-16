/**
 * Read-only audit: list users who likely signed in via phone OTP.
 *
 * Run (uses same env bootstrap as `npm run dev`):
 *   npm run check:phone-login-users
 *   npm run check:phone-login-users -- --firebase --verbose
 *   npm run check:phone-login-users -- --sample 10
 */
import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import { User } from '../modules/user/user.model';

const BATCH_SIZE = 500;

type Classification =
  | 'mongo_phone_heuristic'
  | 'firebase_phone'
  | 'firebase_google'
  | 'ambiguous'
  | 'legacy_fast'
  | 'staff'
  | 'other';

interface UserRow {
  id: string;
  firebaseUid: string;
  phone: string | null;
  email: string | null;
  role: string;
  createdAt: Date | null;
  classification: Classification;
}

function parseArgs(argv: string[]) {
  const useFirebase = argv.includes('--firebase');
  const verbose = argv.includes('--verbose');
  let sample = 0;
  const sampleIdx = argv.indexOf('--sample');
  if (sampleIdx >= 0 && argv[sampleIdx + 1]) {
    const n = parseInt(argv[sampleIdx + 1], 10);
    if (!Number.isNaN(n) && n > 0) sample = n;
  }
  return { useFirebase, verbose, sample };
}

function maskPhone(phone: string | null | undefined): string {
  if (!phone || phone.length < 4) return phone ?? '';
  return `${phone.slice(0, 3)}***${phone.slice(-2)}`;
}

function classifyMongoHeuristic(doc: {
  role?: string;
  firebaseUid?: string;
  phone?: string;
  email?: string;
  authProvider?: string;
}): Classification {
  const role = doc.role ?? 'user';
  const uid = doc.firebaseUid ?? '';

  if (['admin', 'super_admin', 'agency', 'bd'].includes(role)) {
    return 'staff';
  }
  if (uid.startsWith('fast_') || doc.authProvider === 'fast') {
    return 'legacy_fast';
  }

  const hasPhone = typeof doc.phone === 'string' && doc.phone.trim() !== '';
  const hasEmail =
    typeof doc.email === 'string' && doc.email.trim() !== '';

  if (
    ['user', 'creator'].includes(role) &&
    hasPhone &&
    !hasEmail &&
    !uid.startsWith('admin_') &&
    !uid.startsWith('super_admin_')
  ) {
    return 'mongo_phone_heuristic';
  }

  return 'other';
}

async function classifyWithFirebase(
  firebaseUid: string
): Promise<'firebase_phone' | 'firebase_google' | 'ambiguous'> {
  const admin = await import('firebase-admin');
  const user = await admin.auth().getUser(firebaseUid);
  const hasPhone = user.providerData.some((p) => p.providerId === 'phone');
  const hasGoogle = user.providerData.some((p) => p.providerId === 'google.com');
  if (hasPhone && hasGoogle) return 'ambiguous';
  if (hasPhone) return 'firebase_phone';
  if (hasGoogle) return 'firebase_google';
  return 'ambiguous';
}

function printRow(row: UserRow) {
  // eslint-disable-next-line no-console
  console.log(
    `  _id=${row.id} uid=${row.firebaseUid} role=${row.role} phone=${maskPhone(row.phone)} email=${row.email ?? '(none)'} class=${row.classification} created=${row.createdAt?.toISOString() ?? 'n/a'}`,
  );
}

async function main() {
  const { useFirebase, verbose, sample } = parseArgs(process.argv.slice(2));

  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) {
    // eslint-disable-next-line no-console
    console.error('MONGO_URI missing in backend/.env');
    process.exit(1);
  }

  // Plain connect (like seed-admin) — avoid connectDatabase()'s DNS override and
  // process.exit on failure. Use `npm run check:phone-login-users` so
  // scripts/with-dev-env.ps1 preloads NODE_EXTRA_CA_CERTS like `npm run dev`.
  await mongoose.connect(mongoUri);

  // eslint-disable-next-line no-console
  console.log('Check phone-login users — connected\n');

  if (useFirebase) {
    const { initializeFirebase } = await import('../config/firebase');
    initializeFirebase();
  }

  const counts: Record<Classification, number> = {
    mongo_phone_heuristic: 0,
    firebase_phone: 0,
    firebase_google: 0,
    ambiguous: 0,
    legacy_fast: 0,
    staff: 0,
    other: 0,
  };

  const phoneCandidates: UserRow[] = [];
  const samples: UserRow[] = [];

  let lastId: mongoose.Types.ObjectId | null = null;

  for (;;) {
    const filter: Record<string, unknown> = {};
    if (lastId) filter._id = { $gt: lastId };

    const batch = await User.find(filter)
      .select('_id firebaseUid phone email role createdAt authProvider')
      .sort({ _id: 1 })
      .limit(BATCH_SIZE)
      .lean();

    if (batch.length === 0) break;
    lastId = batch[batch.length - 1]._id as mongoose.Types.ObjectId;

    for (const doc of batch) {
      let classification = classifyMongoHeuristic(doc);

      if (
        useFirebase &&
        classification === 'mongo_phone_heuristic' &&
        doc.firebaseUid
      ) {
        try {
          classification = await classifyWithFirebase(doc.firebaseUid);
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn(
            `  ⚠ Firebase lookup failed for ${doc.firebaseUid}: ${(e as Error).message}`,
          );
        }
      }

      counts[classification] += 1;

      const row: UserRow = {
        id: doc._id.toString(),
        firebaseUid: doc.firebaseUid ?? '',
        phone: doc.phone ?? null,
        email: doc.email ?? null,
        role: doc.role ?? 'user',
        createdAt: doc.createdAt ?? null,
        classification,
      };

      if (
        classification === 'mongo_phone_heuristic' ||
        classification === 'firebase_phone'
      ) {
        phoneCandidates.push(row);
        if (verbose) printRow(row);
      }

      if (sample > 0 && samples.length < sample) {
        if (
          classification === 'mongo_phone_heuristic' ||
          classification === 'firebase_phone'
        ) {
          samples.push(row);
        }
      }
    }
  }

  // eslint-disable-next-line no-console
  console.log('\n--- Summary ---');
  for (const [key, value] of Object.entries(counts)) {
    // eslint-disable-next-line no-console
    console.log(`  ${key}: ${value}`);
  }

  const phoneCount = useFirebase
    ? counts.firebase_phone
    : counts.mongo_phone_heuristic;

  // eslint-disable-next-line no-console
  console.log(
    `\nLikely phone-login users (${useFirebase ? 'Firebase-verified' : 'Mongo heuristic'}): ${phoneCount}`,
  );

  if (sample > 0 && samples.length > 0) {
    // eslint-disable-next-line no-console
    console.log(`\n--- Sample (up to ${sample}) ---`);
    for (const row of samples) {
      printRow(row);
    }
  } else if (!verbose && phoneCandidates.length > 0) {
    // eslint-disable-next-line no-console
    console.log(
      `\n${phoneCandidates.length} candidate(s). Use --verbose to list all or --sample N for examples.`,
    );
  }

  await mongoose.disconnect();
  process.exit(0);
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  // eslint-disable-next-line no-console
  console.error(err);
  if (/whitelist|ServerSelection|ReplicaSetNoPrimary/i.test(msg)) {
    // eslint-disable-next-line no-console
    console.error(
      '\nIf `npm run dev` connects but this script does not, run via `npm run check:phone-login-users` ' +
        '(not raw tsx) so scripts/with-dev-env.ps1 preloads TLS/DNS env like dev.\n',
    );
  }
  process.exit(1);
});
