import assert from 'node:assert/strict';
import {
  expandCorsOriginEntry,
  normalizeCorsOriginEntry,
  parseCorsOriginAllowlist,
} from './cors';

function testNormalize() {
  assert.equal(normalizeCorsOriginEntry('  "https://www.flirtycam.in/"  '), 'https://www.flirtycam.in');
  assert.equal(normalizeCorsOriginEntry("'https://flirtycam.in'"), 'https://flirtycam.in');
}

function testExpandBareHost() {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const expanded = expandCorsOriginEntry('flirtycam.in');
    assert.ok(expanded.includes('https://flirtycam.in'));
    assert.ok(expanded.includes('https://www.flirtycam.in'));
  } finally {
    process.env.NODE_ENV = prev;
  }
}

function testExpandWww() {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const expanded = expandCorsOriginEntry('https://www.flirtycam.in');
    assert.ok(expanded.includes('https://www.flirtycam.in'));
    assert.ok(expanded.includes('https://flirtycam.in'));
  } finally {
    process.env.NODE_ENV = prev;
  }
}

function testParseAllowlist() {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const list = parseCorsOriginAllowlist('https://www.flirtycam.in, flirtycam.in');
    assert.notEqual(list, '*');
    assert.ok(Array.isArray(list));
    assert.ok((list as string[]).includes('https://www.flirtycam.in'));
    assert.ok((list as string[]).includes('https://flirtycam.in'));
  } finally {
    process.env.NODE_ENV = prev;
  }
}

testNormalize();
testExpandBareHost();
testExpandWww();
testParseAllowlist();
console.log('cors.config.test.ts: ok');
