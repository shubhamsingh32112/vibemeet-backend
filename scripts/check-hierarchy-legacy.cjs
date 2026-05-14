/**
 * Fail CI if legacy hierarchy symbols remain outside migration/archive paths.
 */
const { readFileSync, readdirSync, statSync } = require('node:fs');
const { join, relative } = require('node:path');

const ROOT = join(__dirname, '..', 'src');
const SKIP_DIRS = new Set(['node_modules', 'dist']);
const ALLOW_PATH_FRAGMENTS = [
  'migrate-agency-bd-hierarchy-swap.ts',
  'verify-agency-bd-hierarchy-swap.ts',
  'hierarchy-verify.contract.test.ts',
];

const PATTERNS = [
  { re: /assignedAgentId/, label: 'assignedAgentId' },
  { re: /assignedAgentLabel/, label: 'assignedAgentLabel' },
  { re: /targetAgentId/, label: 'targetAgentId' },
  { re: /referrerIsAgent/, label: 'referrerIsAgent' },
  { re: /referrerAgentId/, label: 'referrerAgentId' },
  { re: /transferCreatorToAgent/, label: 'transferCreatorToAgent' },
  { re: /CREATOR_TRANSFER_AGENT/, label: 'CREATOR_TRANSFER_AGENT' },
  { re: /role:\s*['"]agent['"]/, label: "role: 'agent'" },
  { re: /\/auth\/agent-login/, label: '/auth/agent-login' },
  { re: /\bassertAgent\b/, label: 'assertAgent' },
];

function walk(dir, files = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (SKIP_DIRS.has(name)) continue;
    const st = statSync(p);
    if (st.isDirectory()) walk(p, files);
    else if (p.endsWith('.ts')) files.push(p);
  }
  return files;
}

const violations = [];
for (const file of walk(ROOT)) {
  const rel = relative(join(__dirname, '..'), file).replace(/\\/g, '/');
  if (ALLOW_PATH_FRAGMENTS.some((f) => rel.includes(f))) continue;
  const src = readFileSync(file, 'utf8');
  for (const { re, label } of PATTERNS) {
    if (re.test(src)) violations.push(`${rel}: ${label}`);
  }
}

if (violations.length) {
  console.error('Legacy hierarchy references found:\n' + violations.join('\n'));
  process.exit(1);
}
console.log('No legacy hierarchy references outside allowed paths.');
