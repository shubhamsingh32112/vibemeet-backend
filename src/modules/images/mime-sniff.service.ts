/**
 * Server-side MIME validation for uploaded images.
 *
 * Client-declared MIME types and file extensions are NEVER trusted.
 * On commit, the backend either:
 *   1) Asks Cloudflare for its metadata (which already enforces image-only),
 *      then double-checks the bytes via `file-type`'s magic-number sniff.
 *   2) Streams the public-variant bytes (via imagedelivery.net CDN URL)
 *      and runs the sniff locally.
 *
 * Accepted MIME types: image/jpeg, image/png, image/webp, image/avif, image/heic.
 * Everything else is rejected (caller deletes the Cloudflare image).
 */

import { downloadImageBytes } from './cloudflare.client';
import { bumpImageCounter } from './image-metrics';

// `file-type` is published as pure ESM (v17+). The backend is built as CJS,
// so a static or literal dynamic `import('file-type')` is translated to
// `require('file-type')` and crashes with ERR_PACKAGE_PATH_NOT_EXPORTED.
// Load it via a runtime `import()` (through `new Function`) so Node's ESM
// loader handles the package while the rest of the file stays CJS-friendly.
type FileTypeResult = { mime: string } | undefined;
let fileTypeFromBufferImpl:
  | ((bytes: Uint8Array | ArrayBuffer | Buffer) => Promise<FileTypeResult>)
  | null = null;

async function getFileTypeFromBuffer(): Promise<
  (bytes: Uint8Array | ArrayBuffer | Buffer) => Promise<FileTypeResult>
> {
  if (fileTypeFromBufferImpl) return fileTypeFromBufferImpl;
  // `module: commonjs` makes TS rewrite `import('file-type')` to `require()`.
  // v17+ is ESM-only, so load through a runtime dynamic import instead.
  const loadEsm = new Function(
    'specifier',
    'return import(specifier)',
  ) as (specifier: string) => Promise<{ fileTypeFromBuffer?: typeof fileTypeFromBufferImpl }>;
  const mod = await loadEsm('file-type');
  fileTypeFromBufferImpl = mod.fileTypeFromBuffer as typeof fileTypeFromBufferImpl &
    NonNullable<typeof fileTypeFromBufferImpl>;
  if (!fileTypeFromBufferImpl) {
    throw new Error('file-type module did not expose fileTypeFromBuffer');
  }
  return fileTypeFromBufferImpl;
}

const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif',
  // HEIC is auto-transcoded to JPEG by Cloudflare on delivery but the source bytes
  // may still be HEIC, so accept it here.
  'image/heic',
  'image/heif',
]);

export class UnsupportedMimeTypeError extends Error {
  readonly code = 'UNSUPPORTED_MIME_TYPE';
  readonly detectedMime: string | null;
  constructor(detected: string | null) {
    super(`unsupported image MIME type: ${detected ?? 'unknown'}`);
    this.detectedMime = detected;
  }
}

export interface SniffResult {
  /** Detected canonical MIME, e.g. 'image/jpeg'. */
  mime: string;
}

/**
 * Sniff via Cloudflare-downloaded bytes. Returns the canonical MIME and
 * throws `UnsupportedMimeTypeError` when the bytes are not an image we accept.
 */
export async function sniffImageMime(imageId: string): Promise<SniffResult> {
  const bytes = await downloadImageBytes(imageId);
  const fileTypeFromBuffer = await getFileTypeFromBuffer();
  const detected = await fileTypeFromBuffer(bytes);
  const mime = detected?.mime ?? null;
  if (!mime || !ALLOWED_MIME_TYPES.has(mime)) {
    bumpImageCounter('mime.rejected', { detected: mime ?? 'unknown' });
    throw new UnsupportedMimeTypeError(mime);
  }
  bumpImageCounter('mime.accepted', { mime });
  return { mime };
}

/** Synchronous MIME sniff on already-fetched bytes (used by workers). */
export async function sniffImageMimeFromBuffer(bytes: Buffer): Promise<SniffResult> {
  const fileTypeFromBuffer = await getFileTypeFromBuffer();
  const detected = await fileTypeFromBuffer(bytes);
  const mime = detected?.mime ?? null;
  if (!mime || !ALLOWED_MIME_TYPES.has(mime)) {
    bumpImageCounter('mime.rejected', { detected: mime ?? 'unknown' });
    throw new UnsupportedMimeTypeError(mime);
  }
  bumpImageCounter('mime.accepted', { mime });
  return { mime };
}
