import { test } from 'node:test';
import assert from 'node:assert/strict';

test('preview cache v2 stores ids only, not full moment documents', () => {
  const entries = [
    {
      momentId: '674abc123def456789012345',
      creator: { id: 'creator1', name: 'Test', verified: false },
    },
  ];
  const parsed = JSON.parse(JSON.stringify(entries)) as typeof entries;
  assert.equal(parsed[0].momentId, entries[0].momentId);
  assert.equal((parsed[0] as { moment?: unknown }).moment, undefined);
});

test('legacy full-moment JSON cache breaks Date methods after parse', () => {
  const moment = {
    _id: '674abc123def456789012345',
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
  };
  const parsed = JSON.parse(JSON.stringify({ moment })) as {
    moment: { createdAt: Date };
  };
  assert.throws(() => parsed.moment.createdAt.toISOString());
});
