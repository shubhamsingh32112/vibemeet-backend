/**
 * Phase 0.4 — Seed Cloudflare Images with the default preset avatars.
 *
 * Reads the canonical preset PNGs from `frontend/lib/assets/<gender>/<file>`,
 * uploads each to Cloudflare Images, and writes the resulting `imageId` map
 * to `backend/src/data/preset-image-ids.json`.
 *
 * Scope: ONE default avatar per gender (used as the auto-assigned image
 * when a new Firebase account first appears — see
 * `auth.controller.ts`'s `buildDefaultFirstLoginProfile`). There is no
 * multi-option preset picker anymore; the listings endpoint returns
 * whatever this map contains, which is exactly these two entries.
 *
 * Layout written to JSON:
 *   {
 *     "male":   { "a2.png":  "<imageId>" },
 *     "female": { "fa2.png": "<imageId>" },
 *     "default": "<imageId for male/a2.png — matches DEFAULT_NEW_USER_GENDER>"
 *   }
 *
 * The runtime loads this manifest via `preset-image-ids.ts`.
 *
 * Run:
 *   npm run seed:preset-avatars-cloudflare
 *
 * Idempotency note: re-running the script uploads FRESH copies to Cloudflare
 * (CF does not dedupe on filename + bytes). The on-disk JSON map is the
 * source of truth and is overwritten on each run, so any old imageIds from
 * a previous run become orphans (cleaned up by the orphan-cleanup queue).
 * Run sparingly — typically once per environment.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import axios from 'axios';
import FormData from 'form-data';
import dotenv from 'dotenv';
import { getCloudflareConfig } from '../config/cloudflare';

dotenv.config();

type Gender = 'male' | 'female';

// Repo-root-relative path to the Flutter assets folder where the canonical
// preset PNGs live. `__dirname` resolves to `backend/src/scripts/`, so three
// `..` segments take us to the repo root, then into `frontend/lib/assets`.
const PRESET_SOURCE_DIR = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  'frontend',
  'lib',
  'assets',
);

// One default avatar per gender. File names intentionally differ — the
// female PNG is `fa2.png` (not `a2.png`) to mirror the file naming under
// `frontend/lib/assets/female/`. The runtime resolver does not assume any
// specific filename — it only uses the `gender → fileName → imageId` map.
const PRESET_FILES: Record<Gender, string> = {
  male: 'a2.png',
  female: 'fa2.png',
};

// The universal `default` field in the manifest points at this entry.
// Must match `DEFAULT_NEW_USER_GENDER` in `auth.controller.ts` so the
// auto-assigned avatar at signup is gender-consistent with the auto-
// assigned gender.
const DEFAULT_AVATAR_GENDER: Gender = 'male';

interface CloudflareUploadResult {
  id: string;
  filename: string;
  uploaded: string;
}

async function readPresetFile(gender: Gender, fileName: string): Promise<Buffer> {
  const filePath = path.join(PRESET_SOURCE_DIR, gender, fileName);
  try {
    return await fs.readFile(filePath);
  } catch (error) {
    throw new Error(
      `Could not read preset PNG at ${filePath}: ${(error as Error).message}\n` +
        `Verify the asset exists in the Flutter assets folder before re-running.`,
    );
  }
}

async function uploadToCloudflare(
  bytes: Buffer,
  filename: string,
  metadata: Record<string, string>,
): Promise<CloudflareUploadResult> {
  const { accountId, apiToken } = getCloudflareConfig();
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/images/v1`;

  const form = new FormData();
  form.append('file', bytes, { filename, contentType: 'image/png' });
  form.append('requireSignedURLs', 'false');
  form.append('metadata', JSON.stringify(metadata));

  const { data } = await axios.post<{
    success: boolean;
    errors: Array<{ code: number; message: string }>;
    result?: CloudflareUploadResult;
  }>(url, form, {
    headers: {
      Authorization: `Bearer ${apiToken}`,
      ...form.getHeaders(),
    },
    maxBodyLength: Infinity,
    timeout: 30000,
  });

  if (!data.success || !data.result) {
    throw new Error(`Cloudflare upload failed: ${JSON.stringify(data.errors)}`);
  }
  return data.result;
}

function isTlsCertError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes('unable to verify the first certificate') ||
    m.includes('self-signed certificate') ||
    m.includes('self signed certificate') ||
    m.includes('cert_has_expired') ||
    m.includes('depth_zero_self_signed_cert') ||
    m.includes('unable_to_verify_leaf_signature')
  );
}

async function main(): Promise<void> {
  console.log('───────────────────────────────────────────────────────');
  console.log('☁️  Seeding preset avatars to Cloudflare Images');
  console.log(`📦 Account: ${getCloudflareConfig().accountId}`);
  console.log(`📥 Source:  ${PRESET_SOURCE_DIR}`);
  console.log('───────────────────────────────────────────────────────');

  const out: Record<Gender, Record<string, string>> & { default: string } = {
    male: {},
    female: {},
    default: '',
  };

  for (const gender of Object.keys(PRESET_FILES) as Gender[]) {
    const fileName = PRESET_FILES[gender];
    const bytes = await readPresetFile(gender, fileName);
    const result = await uploadToCloudflare(bytes, fileName, {
      source: 'preset_avatar_seed',
      gender,
      avatarName: fileName,
    });
    out[gender][fileName] = result.id;
    console.log(`  ✓ ${gender}/${fileName} -> ${result.id}`);

    if (gender === DEFAULT_AVATAR_GENDER) {
      out.default = result.id;
    }
  }

  if (!out.default) {
    // Shouldn't happen — DEFAULT_AVATAR_GENDER is always in PRESET_FILES —
    // but fail loudly rather than write an empty `default` field that the
    // runtime would silently warn about and fall through past.
    throw new Error(
      `Manifest default field is empty after upload. ` +
        `Expected the ${DEFAULT_AVATAR_GENDER}/${PRESET_FILES[DEFAULT_AVATAR_GENDER]} upload to set it.`,
    );
  }

  const target = path.resolve(__dirname, '..', 'data', 'preset-image-ids.json');
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify(out, null, 2) + '\n', 'utf8');
  console.log('───────────────────────────────────────────────────────');
  console.log(`✅ Seed complete. Wrote ${target}`);
  console.log('   Commit this file so the runtime can resolve preset imageIds.');
}

main().catch((error) => {
  const message = (error as Error).message ?? String(error);
  console.error('❌ Failed to seed preset avatars:', message);
  if (isTlsCertError(message)) {
    console.error('');
    console.error('Hint: this is a TLS chain error. On a Windows dev box with');
    console.error('antivirus/proxy SSL interception you can bypass for this');
    console.error('one-shot script:');
    console.error("  $env:NODE_TLS_REJECT_UNAUTHORIZED='0'; npm run seed:preset-avatars-cloudflare");
    console.error('Permanent fix: install your corp/AV root CA + set NODE_EXTRA_CA_CERTS.');
    console.error('Do NOT disable TLS verification in production env.');
  }
  process.exit(1);
});
