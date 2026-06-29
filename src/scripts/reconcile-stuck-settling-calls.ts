import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import { DurableCallSession } from '../modules/billing/call-session.model';
import { BILLING_MAX_SETTLING_MS } from '../modules/billing/billing.constants';
import {
  drainSettlementArtifacts,
  enqueueImmediateSettlementRetry,
  moveCallToRecoveryDeadLetter,
} from '../modules/billing/billing-session-finalization.service';
import { deleteBillingSessionRedisKeys } from '../modules/billing/billing-settlement.service';
import { clearCreatorActiveCallSlotIfStale } from '../modules/availability/creator-active-call-slot.service';
import {
  getDurableCallSession,
  resetDurableCallSessionForSettlementRetry,
} from '../modules/billing/call-session.service';
import { getRedis, callSessionKey, billingRecoveryDeadLetterKey } from '../config/redis';

type Action = 'dead-letter' | 'retry-finalize' | 'recover-failed';

function readArg(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx < 0 || idx + 1 >= process.argv.length) return undefined;
  return process.argv[idx + 1];
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function parseAction(actionArg: string | undefined): Action {
  if (actionArg === 'dead-letter') return 'dead-letter';
  if (actionArg === 'recover-failed') return 'recover-failed';
  return 'retry-finalize';
}

async function clearBillingRedisForCall(
  callId: string,
  callerFirebaseUid: string,
  creatorFirebaseUid: string
): Promise<void> {
  const redis = getRedis();
  await drainSettlementArtifacts(callId, 'manual_cleanup');
  await deleteBillingSessionRedisKeys(redis, callId, callerFirebaseUid, creatorFirebaseUid).catch(
    () => {}
  );
}

async function freeCreatorSlot(callId: string, creatorFirebaseUid: string): Promise<boolean> {
  const result = await clearCreatorActiveCallSlotIfStale(creatorFirebaseUid, {
    endingCallId: callId,
    force: true,
    source: 'reconcile-stuck-settling-calls',
  });
  return result.cleared;
}

async function main(): Promise<void> {
  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) {
    console.error('MONGO_URI missing');
    process.exit(1);
  }

  const execute = hasFlag('--execute');
  const dryRun = !execute || hasFlag('--dry-run');
  const callIdFilter = readArg('--call-id');
  const force = hasFlag('--force');
  const minAgeMs = Math.max(
    1000,
    parseInt(readArg('--min-age-ms') || String(BILLING_MAX_SETTLING_MS), 10) || BILLING_MAX_SETTLING_MS
  );
  const action = parseAction(readArg('--action'));

  await mongoose.connect(mongoUri);
  console.log(
    `Connected to MongoDB (${dryRun ? 'dry-run' : 'execute'} mode, action=${action}, minAgeMs=${minAgeMs}, force=${force})`
  );

  let query: Record<string, unknown>;

  if (action === 'recover-failed') {
    query = {
      finalized: false,
      state: 'failed_settlement',
      ...(force ? {} : { billingSequence: { $gt: 0 } }),
    };
  } else {
    const staleThreshold = new Date(Date.now() - minAgeMs);
    query = {
      finalized: false,
      state: 'settling',
      $or: [
        { finalizationStartedAt: { $lt: staleThreshold } },
        { finalizationStartedAt: { $exists: false }, updatedAt: { $lt: staleThreshold } },
      ],
    };
  }

  if (callIdFilter) {
    query._id = callIdFilter;
  }

  const stuck = await DurableCallSession.find(query)
    .select(
      '_id state finalizationStartedAt lastBillingAt updatedAt callerFirebaseUid creatorFirebaseUid settlementVersion billingSequence'
    )
    .limit(callIdFilter ? 1 : 200)
    .lean();

  console.log(`Matching call_sessions found: ${stuck.length}`);
  if (stuck.length === 0) {
    await mongoose.disconnect();
    return;
  }

  let actionsTaken = 0;
  let creatorsFreed = 0;

  for (const row of stuck) {
    console.log('\n---');
    console.log({
      callId: row._id,
      state: row.state,
      finalizationStartedAt: row.finalizationStartedAt,
      lastBillingAt: row.lastBillingAt,
      updatedAt: row.updatedAt,
      billingSequence: row.billingSequence,
      callerFirebaseUid: row.callerFirebaseUid,
      creatorFirebaseUid: row.creatorFirebaseUid,
      settlementVersion: row.settlementVersion,
    });

    if (dryRun) {
      console.log(`[dry-run] would ${action} and free creator slot`);
      continue;
    }

    const callId = row._id;
    const callerFirebaseUid = row.callerFirebaseUid;
    const creatorFirebaseUid = row.creatorFirebaseUid;

    const { resolveAuthoritativeSettlementTotals } = await import(
      '../modules/billing/billing-settlement-totals.service'
    );
    const authoritativeTotals = await resolveAuthoritativeSettlementTotals(callId);
    if (authoritativeTotals.totalDeductedMicros > 0) {
      await DurableCallSession.updateOne(
        { _id: callId },
        {
          $max: {
            totalUserDebitedMicros: authoritativeTotals.totalDeductedMicros,
            totalCreatorCreditedMicros: authoritativeTotals.totalEarnedMicros,
            billingSequence: authoritativeTotals.billingSequence,
          },
        }
      ).catch(() => {});
    }

    const redis = getRedis();
    const sessionRaw = await redis.get(callSessionKey(callId));
    if (sessionRaw) {
      try {
        const session = JSON.parse(sessionRaw) as {
          userFirebaseUid?: string;
          creatorFirebaseUid?: string;
        };
        await clearBillingRedisForCall(
          callId,
          session.userFirebaseUid || callerFirebaseUid,
          session.creatorFirebaseUid || creatorFirebaseUid
        );
      } catch {
        await drainSettlementArtifacts(callId, 'manual_cleanup');
      }
    } else {
      await drainSettlementArtifacts(callId, 'manual_cleanup');
    }

    if (action === 'dead-letter') {
      await moveCallToRecoveryDeadLetter(callId, 'manual_cleanup', 'reconciliation_worker');
    } else if (action === 'recover-failed') {
      const durable = await getDurableCallSession(callId);
      if (!durable || durable.state !== 'failed_settlement') {
        console.log(`[skip] ${callId} is not failed_settlement`);
        continue;
      }
      if (durable.billingSequence <= 0 && !force) {
        console.log(`[skip] ${callId} billingSequence=0 (use --force to recover)`);
        continue;
      }
      await redis.del(billingRecoveryDeadLetterKey(callId)).catch(() => 0);
      const reset = await resetDurableCallSessionForSettlementRetry(callId);
      if (!reset) {
        console.log(`[skip] ${callId} reset failed`);
        continue;
      }
      await enqueueImmediateSettlementRetry({
        callId,
        reason: 'reconciliation',
        source: 'reconciliation_worker',
      });
    } else {
      await DurableCallSession.updateOne(
        { _id: callId, finalized: false, state: 'settling' },
        {
          $set: { state: 'ending' },
          $unset: { finalizationOwnerId: '', finalizationStartedAt: '' },
          $inc: { settlementVersion: 1 },
        }
      );
      await enqueueImmediateSettlementRetry({
        callId,
        reason: 'reconciliation',
        source: 'reconciliation_worker',
      });
    }

    if (creatorFirebaseUid) {
      const freed = await freeCreatorSlot(callId, creatorFirebaseUid);
      if (freed) creatorsFreed += 1;
    }

    actionsTaken += 1;
    console.log(`[execute] ${action} completed for ${callId}`);
  }

  console.log('\n=== Summary ===');
  console.log({ found: stuck.length, actionsTaken, creatorsFreed, dryRun, action, force });

  await mongoose.disconnect();
}

main().catch((error) => {
  console.error('reconcile-stuck-settling-calls failed', error);
  process.exit(1);
});
