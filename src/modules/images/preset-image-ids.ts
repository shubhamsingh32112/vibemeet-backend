/**
 * Loads the preset-avatar manifest produced by the
 * `seed:preset-avatars-cloudflare` script.
 *
 * Layout: backend/src/data/preset-image-ids.json
 *   {
 *     "male":   { "a1.png": "<imageId>", ... },
 *     "female": { "a1.png": "<imageId>", ... },
 *     "default": "<imageId for the canonical fallback avatar>"
 *   }
 *
 * The runtime caches the file at startup. If the manifest is empty
 * (e.g. during bootstrap before seed runs), `getDefaultPresetImageId`
 * returns `null` and callers should fall back to the legacy default URL.
 */

import fs from 'node:fs';
import path from 'node:path';
import { logWarning, logInfo } from '../../utils/logger';

type Gender = 'male' | 'female';

interface PresetManifest {
  male: Record<string, string>;
  female: Record<string, string>;
  default: string;
}

const EMPTY_MANIFEST: PresetManifest = { male: {}, female: {}, default: '' };

let cached: PresetManifest | null = null;

function manifestPath(): string {
  const distPath = path.resolve(__dirname, '..', '..', 'data', 'preset-image-ids.json');
  if (fs.existsSync(distPath)) return distPath;
  const srcPath = path.resolve(__dirname, '..', '..', '..', 'src', 'data', 'preset-image-ids.json');
  return fs.existsSync(srcPath) ? srcPath : distPath;
}

function load(): PresetManifest {
  if (cached) return cached;
  const target = manifestPath();
  try {
    const raw = fs.readFileSync(target, 'utf8');
    const parsed = JSON.parse(raw) as Partial<PresetManifest>;
    cached = {
      male: parsed.male ?? {},
      female: parsed.female ?? {},
      default: typeof parsed.default === 'string' ? parsed.default : '',
    };
    if (!cached.default) {
      logWarning('preset-image-ids manifest has no default imageId — runtime will fall back to legacy default avatar URL', {
        target,
      });
    } else {
      logInfo('preset-image-ids manifest loaded', {
        target,
        male: Object.keys(cached.male).length,
        female: Object.keys(cached.female).length,
        defaultImageId: cached.default,
      });
    }
    return cached;
  } catch (error) {
    logWarning('preset-image-ids manifest missing or unreadable; preset avatars unavailable', {
      target,
      error: (error as Error).message,
    });
    cached = EMPTY_MANIFEST;
    return cached;
  }
}

export function getPresetImageId(gender: Gender, fileName: string): string | null {
  const manifest = load();
  return manifest[gender]?.[fileName] ?? null;
}

export function getDefaultPresetImageId(): string | null {
  const manifest = load();
  return manifest.default || null;
}

export function listPresetImageIds(gender: Gender): Array<{ fileName: string; imageId: string }> {
  const manifest = load();
  return Object.entries(manifest[gender] || {}).map(([fileName, imageId]) => ({
    fileName,
    imageId,
  }));
}

/** Test-only escape hatch. */
export function __resetPresetCacheForTests(): void {
  cached = null;
}
