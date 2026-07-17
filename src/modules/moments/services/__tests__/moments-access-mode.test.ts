import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  __resetMomentsConfigForTests,
  getMomentsAccessMode,
  isMomentsFreeAccessMode,
} from '../../../../config/moments';
import { applyAudienceToFeedOrdering } from '../feed-audience.service';

describe('moments access mode config', () => {
  test('defaults to paid', () => {
    __resetMomentsConfigForTests();
    delete process.env.MOMENTS_ACCESS_MODE;
    assert.equal(getMomentsAccessMode(), 'paid');
    assert.equal(isMomentsFreeAccessMode(), false);
  });

  test('free when env set', () => {
    __resetMomentsConfigForTests();
    process.env.MOMENTS_ACCESS_MODE = 'free';
    assert.equal(getMomentsAccessMode(), 'free');
    assert.equal(isMomentsFreeAccessMode(), true);
    __resetMomentsConfigForTests();
    delete process.env.MOMENTS_ACCESS_MODE;
  });

  test('invalid env falls back to paid', () => {
    __resetMomentsConfigForTests();
    process.env.MOMENTS_ACCESS_MODE = 'invalid';
    assert.equal(getMomentsAccessMode(), 'paid');
    __resetMomentsConfigForTests();
    delete process.env.MOMENTS_ACCESS_MODE;
  });
});

describe('applyAudienceToFeedOrdering free mode', () => {
  test('keeps preview moments exactly once as feed items in free mode', () => {
    __resetMomentsConfigForTests();
    process.env.MOMENTS_ACCESS_MODE = 'free';
    const ordering = {
      moments: [
        { section: 'preview' as const, moment: {}, creatorMeta: {} },
        { section: 'feed' as const, moment: {}, creatorMeta: {} },
      ],
      sections: { previewEndIndex: 1 },
    };
    const result = applyAudienceToFeedOrdering(ordering as never, false);
    assert.equal(result.sections.previewEndIndex, 0);
    assert.equal(result.moments.length, 2);
    assert.deepEqual(result.moments.map((item) => item.section), ['feed', 'feed']);
    __resetMomentsConfigForTests();
    delete process.env.MOMENTS_ACCESS_MODE;
  });
});

test('moment-presentation handles free mode before entitlement', () => {
  const src = readFileSync(
    join(__dirname, '../moment-presentation.service.ts'),
    'utf8',
  );
  assert.ok(src.includes('isMomentsFreeAccessMode()'));
  assert.ok(!src.includes('FREE_MODE'));
});

test('entitlement service resolves free mode before subscription tiers', () => {
  const src = readFileSync(
    join(__dirname, '../entitlement.service.ts'),
    'utf8',
  );
  assert.ok(src.includes('isMomentsFreeAccessMode'));
  assert.ok(src.includes("reason: 'FREE'"));
});
