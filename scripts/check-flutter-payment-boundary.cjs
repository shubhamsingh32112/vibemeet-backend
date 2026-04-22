const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const frontendRoot = path.join(repoRoot, '..', 'frontend');

const blockedPatterns = [
  /razorpay/gi,
  /rzp_/gi,
  /razorpay_payment_id/gi,
  /razorpay_signature/gi,
  /razorpay_order_id/gi,
];

const scanRoots = [
  path.join(frontendRoot, 'lib'),
  path.join(frontendRoot, 'android', 'app', 'src', 'main'),
  path.join(frontendRoot, 'ios', 'Runner'),
];

const allowlistedFiles = new Set([
  path.normalize(path.join(frontendRoot, 'razorpay_flutter_documentation.md')),
]);

function listFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(full));
    } else {
      files.push(full);
    }
  }
  return files;
}

function shouldScan(filePath) {
  const normalized = path.normalize(filePath);
  if (allowlistedFiles.has(normalized)) return false;
  return (
    normalized.endsWith('.dart') ||
    normalized.endsWith('.xml') ||
    normalized.endsWith('.plist') ||
    normalized.endsWith('.yaml')
  );
}

const violations = [];

for (const root of scanRoots) {
  if (!fs.existsSync(root)) continue;
  for (const filePath of listFiles(root)) {
    if (!shouldScan(filePath)) continue;
    const content = fs.readFileSync(filePath, 'utf8');
    for (const pattern of blockedPatterns) {
      pattern.lastIndex = 0;
      if (pattern.test(content)) {
        violations.push(path.relative(repoRoot, filePath).replace(/\\/g, '/'));
        break;
      }
    }
  }
}

if (violations.length > 0) {
  console.error('Flutter payment boundary guard failed.');
  console.error('Razorpay-specific identifiers were found in Flutter runtime files:');
  for (const v of violations) {
    console.error(` - ${v}`);
  }
  process.exit(1);
}

console.log('Flutter payment boundary guard passed.');
