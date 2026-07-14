import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const adminWebsiteRoot = join(__dirname, '../../../../adminWebsite/src');

function walkTsx(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === 'bd' || name === 'agency') continue;
      walkTsx(full, out);
    } else if (/\.(tsx|ts)$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

test('every helpKey in Superadmin pages exists in metric help registry', () => {
  const registrySrc = readFileSync(
    join(adminWebsiteRoot, 'content/superadminMetricHelp.ts'),
    'utf8'
  );
  const registryKeys = new Set<string>();
  for (const m of registrySrc.matchAll(/^\s+'([^']+)':\s*\{/gm)) {
    registryKeys.add(m[1]);
  }
  assert.ok(registryKeys.size >= 50, 'expected substantial help registry');

  const pageRoots = [
    join(adminWebsiteRoot, 'pages/dashboard'),
    join(adminWebsiteRoot, 'pages/users'),
    join(adminWebsiteRoot, 'pages/finance'),
    join(adminWebsiteRoot, 'pages/revenue'),
    join(adminWebsiteRoot, 'pages/moments'),
    join(adminWebsiteRoot, 'pages/monitoring'),
    join(adminWebsiteRoot, 'pages/settings'),
    join(adminWebsiteRoot, 'pages'),
  ];

  const usedKeys = new Set<string>();
  for (const root of pageRoots) {
    for (const file of walkTsx(root)) {
      if (file.includes(`${join('pages', 'bd')}`) || file.includes(`${join('pages', 'agency')}`)) {
        continue;
      }
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/helpKey=["']([^"']+)["']/g)) {
        usedKeys.add(m[1]);
      }
      for (const m of src.matchAll(/columnHelp=\{\{([^}]+)\}\}/gs)) {
        const block = m[1];
        for (const kv of block.matchAll(/:\s*['"]([^'"]+)['"]/g)) {
          usedKeys.add(kv[1]);
        }
      }
    }
  }

  const missing: string[] = [];
  for (const key of usedKeys) {
    if (!registryKeys.has(key)) missing.push(key);
  }
  assert.deepEqual(missing, [], `missing registry keys: ${missing.join(', ')}`);
});
