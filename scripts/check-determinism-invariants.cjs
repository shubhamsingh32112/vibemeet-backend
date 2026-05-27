/**
 * AST-backed determinism guardrails:
 * - lifecycle mutation ownership
 * - presence Redis write ownership
 * - legacy scheduler symbol usage
 * - billing emit ownership
 */
const { readFileSync, readdirSync, statSync } = require('node:fs');
const { join, relative } = require('node:path');
const ts = require('typescript');

const ROOT = join(__dirname, '..');
const BACKEND_SRC = join(ROOT, 'src');
const SKIP_DIRS = new Set(['node_modules', 'dist']);

const OWNERSHIP_ALLOWLIST = {
  presence_keys: ['src/modules/availability/presence.service.ts'],
  billing_emits: ['src/modules/billing/billing-emitter.service.ts'],
  lifecycle_machine: ['src/modules/billing/billing-lifecycle.machine.ts'],
  lifecycle_transition_appliers: [
    'src/modules/billing/billing.service.ts',
    'src/modules/billing/billing-watchdog.service.ts',
    'src/modules/billing/billing-session-finalization.service.ts',
  ],
  active_scheduler_symbols: ['src/config/redis.ts'],
};

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

function isAllowed(relPath, allowFragments) {
  return allowFragments.some((frag) => relPath.includes(frag));
}

function isBillingLifecycleAssignment(node) {
  if (!ts.isBinaryExpression(node)) return false;
  if (node.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return false;
  const left = node.left;
  if (ts.isPropertyAccessExpression(left)) {
    return left.name.text === 'lifecycleState';
  }
  if (ts.isElementAccessExpression(left)) {
    return ts.isStringLiteral(left.argumentExpression) &&
      left.argumentExpression.text === 'lifecycleState';
  }
  return false;
}

function isRedisWriteCall(node) {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) {
    return false;
  }
  const method = node.expression.name.text;
  if (!['set', 'setex', 'del'].includes(method)) return false;
  return node.arguments.some((arg) => {
    if (!ts.isCallExpression(arg)) return false;
    if (ts.isIdentifier(arg.expression)) {
      return arg.expression.text === 'creatorPresenceKey' || arg.expression.text === 'availabilityKey';
    }
    return false;
  });
}

function isBillingEmitCall(node) {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) {
    return false;
  }
  if (node.expression.name.text !== 'emit') return false;
  if (!node.arguments.length) return false;
  const first = node.arguments[0];
  if (!ts.isStringLiteral(first) && !ts.isNoSubstitutionTemplateLiteral(first)) return false;
  return [
    'billing:started',
    'billing:update',
    'billing:settled',
    'billing:recover-state:response',
  ].includes(first.text);
}

function containsLegacySchedulerSymbol(source) {
  return (
    source.includes('ACTIVE_BILLING_CALLS_KEY') ||
    source.includes('billing:active_calls')
  );
}

function collectViolations(rel, source) {
  const violations = [];
  const sf = ts.createSourceFile(rel, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  if (
    !isAllowed(rel, OWNERSHIP_ALLOWLIST.active_scheduler_symbols) &&
    containsLegacySchedulerSymbol(source)
  ) {
    violations.push(`active_billing_zset_usage: ${rel}`);
  }

  function visit(node) {
    if (
      isBillingLifecycleAssignment(node) &&
      !isAllowed(rel, OWNERSHIP_ALLOWLIST.lifecycle_machine) &&
      !isAllowed(rel, OWNERSHIP_ALLOWLIST.lifecycle_transition_appliers)
    ) {
      violations.push(`direct_lifecycle_assignment: ${rel}`);
    }

    if (
      isRedisWriteCall(node) &&
      !isAllowed(rel, OWNERSHIP_ALLOWLIST.presence_keys)
    ) {
      violations.push(`direct_presence_redis_write: ${rel}`);
    }

    if (
      isBillingEmitCall(node) &&
      !isAllowed(rel, OWNERSHIP_ALLOWLIST.billing_emits)
    ) {
      violations.push(`adhoc_billing_emit_outside_snapshot_emitter: ${rel}`);
    }

    ts.forEachChild(node, visit);
  }
  visit(sf);
  return violations;
}

function runInvariantGuard() {
  const violations = [];
  for (const file of walk(BACKEND_SRC)) {
    const rel = relative(ROOT, file).replace(/\\/g, '/');
    const src = readFileSync(file, 'utf8');
    violations.push(...collectViolations(rel, src));
  }
  return violations;
}

if (require.main === module) {
  const violations = runInvariantGuard();
  if (violations.length > 0) {
    console.error('Determinism invariant violations found:\n' + violations.join('\n'));
    process.exit(1);
  }

  console.log('Determinism invariant checks passed (AST mode).');
}

module.exports = {
  collectViolations,
  runInvariantGuard,
};

