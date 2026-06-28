import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRechargeBenefits } from '../recharge-pricing.service';

const pack = { priceInr: 1000, coins: 500 };

describe('resolveRechargeBenefits', () => {
  test('no perks when VIP disabled', async () => {
    const result = await resolveRechargeBenefits('user1', pack, {
      vipEnabled: false,
      vipActive: true,
      rechargeDiscountBps: 1000,
      bonusBps: 1000,
      vipRechargeBonusEnabled: true,
    });
    assert.equal(result.discountedPriceInr, 1000);
    assert.equal(result.bonusCoins, 0);
    assert.equal(result.totalCoins, 500);
    assert.equal(result.benefitsApplied, false);
  });

  test('no perks when user is not VIP', async () => {
    const result = await resolveRechargeBenefits('user1', pack, {
      vipEnabled: true,
      vipActive: false,
      rechargeDiscountBps: 1000,
      bonusBps: 1000,
      vipRechargeBonusEnabled: true,
    });
    assert.equal(result.discountedPriceInr, 1000);
    assert.equal(result.bonusCoins, 0);
    assert.equal(result.totalCoins, 500);
  });

  test('applies 10% INR discount for VIP', async () => {
    const result = await resolveRechargeBenefits('user1', pack, {
      vipEnabled: true,
      vipActive: true,
      rechargeDiscountBps: 1000,
      vipRechargeBonusEnabled: false,
    });
    assert.equal(result.discountedPriceInr, 900);
    assert.equal(result.discountPercent, 10);
    assert.equal(result.vipDiscountApplied, true);
    assert.equal(result.bonusCoins, 0);
  });

  test('applies 10% bonus coins when flag enabled', async () => {
    const result = await resolveRechargeBenefits('user1', pack, {
      vipEnabled: true,
      vipActive: true,
      rechargeDiscountBps: 0,
      bonusBps: 1000,
      vipRechargeBonusEnabled: true,
    });
    assert.equal(result.bonusCoins, 50);
    assert.equal(result.totalCoins, 550);
    assert.equal(result.bonusReason, 'VIP');
    assert.equal(result.vipBonusApplied, true);
  });

  test('stacks discount and bonus for VIP', async () => {
    const result = await resolveRechargeBenefits('user1', pack, {
      vipEnabled: true,
      vipActive: true,
      rechargeDiscountBps: 1000,
      bonusBps: 1000,
      vipRechargeBonusEnabled: true,
    });
    assert.equal(result.discountedPriceInr, 900);
    assert.equal(result.bonusCoins, 50);
    assert.equal(result.totalCoins, 550);
    assert.equal(result.benefitsApplied, true);
  });

  test('discount never drops price below 1 INR', async () => {
    const result = await resolveRechargeBenefits(
      'user1',
      { priceInr: 1, coins: 10 },
      {
        vipEnabled: true,
        vipActive: true,
        rechargeDiscountBps: 1000,
      },
    );
    assert.equal(result.discountedPriceInr, 1);
  });
});
