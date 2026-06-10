import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeFeedRankScore } from './creator-feed-rank-score';

test('encodeFeedRankScore orders online before on_call before offline', () => {
  const ts = Date.UTC(2024, 0, 15);
  const online = encodeFeedRankScore('online', ts);
  const onCall = encodeFeedRankScore('on_call', ts);
  const offline = encodeFeedRankScore('offline', ts);
  assert.ok(online < onCall);
  assert.ok(onCall < offline);
});

test('encodeFeedRankScore breaks ties by newer createdAt first within tier', () => {
  const older = encodeFeedRankScore('online', Date.UTC(2020, 0, 1));
  const newer = encodeFeedRankScore('online', Date.UTC(2024, 0, 1));
  assert.ok(newer < older);
});
