/**
 * Phase 0.3 — Cloudflare Images variant bootstrap.
 *
 * Idempotently creates the canonical variant set used by the app:
 *   avatarXs (64), avatarSm (128), avatarMd (256), feedTile (256x384),
 *   callPhoto (512), callBg (w=1400 flex), galleryThumb (400),
 *   galleryMd (800), galleryXl (1600).
 *
 * NOTE: Cloudflare's variant-name validator rejects hyphens and underscores
 * with HTTP 400 / code 5400. Names must be alphanumeric only — we use
 * camelCase so the URL path segment matches the camelCase getter names on
 * `AvatarUrls` / `GalleryUrls`.
 *
 * The `public` variant is intentionally NOT managed here. Cloudflare
 * auto-provisions it on every Images account with sensible defaults
 * (serves the source image at native dimensions) and PATCH attempts
 * against it return spurious HTTP 500s (code 5500, "internal error").
 * `buildAdminOriginalUrl(...)` in `image-url.ts` still resolves to the
 * auto-provisioned `/imageId/public` URL — we just don't try to redefine
 * its config from this script.
 *
 * Variant rules:
 *   - `metadata: "none"`        → strip EXIF/GPS on delivery (privacy)
 *   - `neverRequireSignedURLs`  → public delivery (private gallery / signed URLs deferred)
 *   - `fit`/`width`/`height`    → see plan §3 variant table
 *
 * Run:
 *   npm run bootstrap:cloudflare-variants
 *
 * Requires: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_IMAGES_API_TOKEN.
 */

import axios, { type AxiosError } from 'axios';
import dotenv from 'dotenv';
import { getCloudflareConfig } from '../config/cloudflare';

dotenv.config();

type Fit = 'scale-down' | 'contain' | 'cover' | 'crop' | 'pad';

interface VariantSpec {
  id: string;
  width: number;
  height?: number;
  fit: Fit;
  /** Background color for `pad`/`contain` results, e.g. '#000000'. */
  background?: string;
  metadata?: 'keep' | 'copyright' | 'none';
}

const VARIANTS: VariantSpec[] = [
  { id: 'avatarXs',     width: 64,   height: 64,   fit: 'cover',      metadata: 'none' },
  { id: 'avatarSm',     width: 128,  height: 128,  fit: 'cover',      metadata: 'none' },
  { id: 'avatarMd',     width: 256,  height: 256,  fit: 'cover',      metadata: 'none' },
  { id: 'feedTile',     width: 256,  height: 384,  fit: 'cover',      metadata: 'none' },
  { id: 'callPhoto',    width: 512,  height: 512,  fit: 'cover',      metadata: 'none' },
  { id: 'callBg',       width: 1400,               fit: 'scale-down', metadata: 'none' },
  { id: 'galleryThumb', width: 400,  height: 400,  fit: 'cover',      metadata: 'none' },
  { id: 'galleryMd',    width: 800,                fit: 'scale-down', metadata: 'none' },
  { id: 'galleryXl',    width: 1600,               fit: 'scale-down', metadata: 'none' },
  // `public` is Cloudflare-managed — see header comment.
];

interface CloudflareApiResponse<T = unknown> {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  messages?: unknown[];
  result?: T;
}

function describeAxiosError(error: AxiosError): string {
  const status = error.response?.status ?? 'unknown';
  const data = error.response?.data;
  if (data && typeof data === 'object') {
    return `HTTP ${status}: ${JSON.stringify(data)}`;
  }
  return `HTTP ${status}: ${error.message}`;
}

type UpsertOutcome = 'created' | 'updated';

async function upsertVariant(spec: VariantSpec): Promise<UpsertOutcome> {
  const { accountId, apiToken } = getCloudflareConfig();
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/images/v1/variants`;

  const options: Record<string, unknown> = {
    fit: spec.fit,
    width: spec.width,
    metadata: spec.metadata ?? 'none',
    neverRequireSignedURLs: true,
  };
  if (spec.height !== undefined) options.height = spec.height;
  if (spec.background !== undefined) options.background = spec.background;

  const body = {
    id: spec.id,
    options,
    neverRequireSignedURLs: true,
  };

  const headers = {
    Authorization: `Bearer ${apiToken}`,
    'Content-Type': 'application/json',
  };

  // POST creates. If it exists (409), fall through to PATCH for idempotent update.
  try {
    const { data } = await axios.post<CloudflareApiResponse>(url, body, { headers, timeout: 15000 });
    if (data.success) {
      console.log(`  + created ${spec.id}`);
      return 'created';
    }
    throw new Error(`create failed: ${JSON.stringify(data.errors)}`);
  } catch (error) {
    const ax = error as AxiosError<CloudflareApiResponse>;
    const code = ax.response?.data?.errors?.[0]?.code;
    const isAlreadyExists = ax.response?.status === 409 || code === 5403;
    if (!isAlreadyExists) {
      throw new Error(`create ${spec.id}: ${describeAxiosError(ax)}`);
    }
  }

  // Idempotent update path.
  const patchUrl = `${url}/${encodeURIComponent(spec.id)}`;
  try {
    const { data } = await axios.patch<CloudflareApiResponse>(patchUrl, { options, neverRequireSignedURLs: true }, { headers, timeout: 15000 });
    if (!data.success) {
      throw new Error(`patch failed: ${JSON.stringify(data.errors)}`);
    }
    console.log(`  ~ updated ${spec.id}`);
    return 'updated';
  } catch (error) {
    const ax = error as AxiosError<CloudflareApiResponse>;
    throw new Error(`patch ${spec.id}: ${describeAxiosError(ax)}`);
  }
}

interface FailureRecord {
  variantId: string;
  message: string;
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
  console.log('☁️  Cloudflare Images: bootstrapping variants');
  console.log(`📦 Account: ${getCloudflareConfig().accountId}`);
  console.log(`🚚 Delivery: ${getCloudflareConfig().deliveryHost}`);
  console.log('───────────────────────────────────────────────────────');

  let created = 0;
  let updated = 0;
  const failures: FailureRecord[] = [];

  for (const variant of VARIANTS) {
    try {
      const outcome = await upsertVariant(variant);
      if (outcome === 'created') created += 1;
      else updated += 1;
    } catch (error) {
      const message = (error as Error).message;
      console.error(`  ✗ ${variant.id}: ${message}`);
      failures.push({ variantId: variant.id, message });
    }
  }

  const total = VARIANTS.length;
  console.log('───────────────────────────────────────────────────────');
  console.log(`Summary: ${created} created, ${updated} updated, ${failures.length} failed (of ${total})`);

  if (failures.length === 0) {
    console.log('✅ Variant bootstrap succeeded for all variants.');
    console.log(
      `   Servable at https://${getCloudflareConfig().deliveryHost}/${getCloudflareConfig().accountHash}/<IMAGE_ID>/<VARIANT>`,
    );
    return;
  }

  console.error('❌ Variant bootstrap FAILED — production cutover is NOT safe yet.');
  console.error('   Re-run after fixing the underlying issue. The script is idempotent.');

  // Surface a single targeted hint when every failure is a TLS chain issue —
  // this is by far the most common cause when running the script from a
  // Windows dev machine with antivirus/proxy SSL interception.
  const allTlsErrors = failures.every((f) => isTlsCertError(f.message));
  if (allTlsErrors) {
    console.error('');
    console.error('   Hint: every failure is a TLS chain error (UNABLE_TO_VERIFY_LEAF_SIGNATURE).');
    console.error('   Node could not validate Cloudflare\'s certificate against its trusted CAs.');
    console.error('   Workaround for one-shot dev runs (PowerShell):');
    console.error('     $env:NODE_TLS_REJECT_UNAUTHORIZED=\'0\'; npm run bootstrap:cloudflare-variants');
    console.error('   Permanent fix: install your corp/AV root CA and set NODE_EXTRA_CA_CERTS.');
    console.error('   Do NOT disable TLS verification in production env.');
  }

  process.exit(1);
}

main().catch((error) => {
  console.error('❌ Variant bootstrap crashed unexpectedly:', error);
  process.exit(1);
});
