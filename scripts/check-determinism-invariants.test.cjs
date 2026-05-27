const assert = require('node:assert/strict');
const { collectViolations } = require('./check-determinism-invariants.cjs');

function expectViolation(name, rel, source) {
  const violations = collectViolations(rel, source);
  assert(
    violations.some((v) => v.startsWith(`${name}:`)),
    `Expected violation "${name}" for ${rel}, got: ${violations.join(', ')}`
  );
}

function run() {
  expectViolation(
    'direct_lifecycle_assignment',
    'src/modules/billing/fake.ts',
    `function x(session){ session['lifecycleState'] = 'ACTIVE'; }`
  );

  expectViolation(
    'direct_presence_redis_write',
    'src/modules/availability/fake.ts',
    `function x(redis, uid){ return redis.setex(creatorPresenceKey(uid), 10, 'online'); }`
  );

  expectViolation(
    'adhoc_billing_emit_outside_snapshot_emitter',
    'src/modules/billing/fake-emitter.ts',
    `function x(io){ io.emit('billing:update', { ok: true }); }`
  );

  expectViolation(
    'active_billing_zset_usage',
    'src/modules/billing/fake-zset.ts',
    `const key = 'billing:active_calls';`
  );

  console.log('Determinism invariant AST tests passed.');
}

run();
