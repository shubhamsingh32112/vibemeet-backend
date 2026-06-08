const fs = require('fs');
const path = require('path');

const serverPath = path.join(__dirname, '../src/server.ts');
const lines = fs.readFileSync(serverPath, 'utf8').split(/\r?\n/);

const startMetrics = lines.findIndex((l) => l.includes('// Metrics endpoint'));
const endHealth = lines.findIndex((l) => l.includes('// API routes'));

if (startMetrics < 0 || endHealth < 0) {
  console.error('Could not find markers', { startMetrics, endHealth });
  process.exit(1);
}

const replacement = [
  'registerMetricsRoute(app);',
  'registerHealthRoutes(app);',
  '',
];

const next = [...lines.slice(0, startMetrics), ...replacement, ...lines.slice(endHealth)];
fs.writeFileSync(serverPath, next.join('\n'));
console.log('Replaced metrics/health block');
