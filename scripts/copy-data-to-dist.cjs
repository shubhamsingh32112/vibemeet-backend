/**
 * Copies runtime data assets (e.g. preset-image-ids.json) into dist/ for production.
 */
const fs = require('node:fs');
const path = require('node:path');

const srcDir = path.resolve(__dirname, '..', 'src', 'data');
const destDir = path.resolve(__dirname, '..', 'dist', 'data');

if (!fs.existsSync(srcDir)) {
  console.warn('[copy-data-to-dist] src/data missing — skip');
  process.exit(0);
}

fs.mkdirSync(destDir, { recursive: true });
fs.cpSync(srcDir, destDir, { recursive: true });
console.log(`[copy-data-to-dist] copied ${srcDir} -> ${destDir}`);
