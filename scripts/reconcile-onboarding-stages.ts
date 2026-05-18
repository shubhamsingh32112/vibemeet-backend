/**
 * Reconcile onboarding stage/timestamp data.
 *
 * Usage:
 *   DRY_RUN=true npx ts-node -r tsconfig-paths/register scripts/reconcile-onboarding-stages.ts
 *   DRY_RUN=false npx ts-node -r tsconfig-paths/register scripts/reconcile-onboarding-stages.ts
 */
import mongoose from 'mongoose';
import { User } from '../src/modules/user/user.model';

const BATCH_SIZE = 500;

function normalizeStage(stage?: string | null): 'welcome' | 'bonus' | 'permissions' | 'completed' {
  if (stage === 'completed') return 'completed';
  if (stage === 'permission' || stage === 'permissions') return 'permissions';
  // v2: legacy bonus stage maps to permissions
  if (stage === 'bonus') return 'permissions';
  return 'welcome';
}

function reconcileTimestamps(input: {
  onboardingWelcomeSeenAt?: Date | null;
  onboardingBonusSeenAt?: Date | null;
  onboardingPermissionSeenAt?: Date | null;
  onboardingCompletedAt?: Date | null;
}) {
  const {
    onboardingWelcomeSeenAt,
    onboardingBonusSeenAt,
    onboardingPermissionSeenAt,
    onboardingCompletedAt,
  } = input;
  let welcomeAt = onboardingWelcomeSeenAt ?? null;
  let bonusAt = onboardingBonusSeenAt ?? null;
  let permissionAt = onboardingPermissionSeenAt ?? null;
  const completedAt = onboardingCompletedAt ?? null;

  // Only infer backward timestamps when a later timestamp exists.
  if (!permissionAt && completedAt) permissionAt = completedAt;
  if (!bonusAt && permissionAt) bonusAt = permissionAt;
  if (!welcomeAt && bonusAt) welcomeAt = bonusAt;

  let orderCorrections = 0;
  // Clamp chronology to ensure welcome <= bonus <= permission <= completed.
  if (permissionAt && completedAt && permissionAt > completedAt) {
    permissionAt = completedAt;
    orderCorrections += 1;
  }
  if (bonusAt && permissionAt && bonusAt > permissionAt) {
    bonusAt = permissionAt;
    orderCorrections += 1;
  }
  if (welcomeAt && bonusAt && welcomeAt > bonusAt) {
    welcomeAt = bonusAt;
    orderCorrections += 1;
  }

  return {
    onboardingWelcomeSeenAt: welcomeAt,
    onboardingBonusSeenAt: bonusAt,
    onboardingPermissionSeenAt: permissionAt,
    onboardingCompletedAt: completedAt,
    orderCorrections,
  };
}

async function main(): Promise<void> {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    console.error('Set MONGODB_URI');
    process.exit(1);
  }
  const dryRun = process.env.DRY_RUN !== 'false';

  await mongoose.connect(uri);
  console.log(`[RECONCILE] connected dryRun=${dryRun}`);

  const cursor = User.find(
    {},
    '_id onboardingStage onboardingFlowVersion onboardingWelcomeSeenAt onboardingBonusSeenAt onboardingPermissionSeenAt onboardingCompletedAt'
  )
    .lean()
    .cursor();

  let scanned = 0;
  let stageNormalized = 0;
  let bonusToPermissions = 0;
  let flowVersionUpgraded = 0;
  let timestampsReconciled = 0;
  let chronologyClamped = 0;
  const sampleFixes: string[] = [];
  const ops: Parameters<typeof User.bulkWrite>[0] = [];

  for await (const user of cursor) {
    scanned += 1;
    const rawStage = user.onboardingStage ?? null;
    const normalizedStage = normalizeStage(rawStage);
    const reconciled = reconcileTimestamps(user);
    const { orderCorrections, ...reconciledTimestamps } = reconciled;
    const stageChanged =
      normalizedStage !== normalizeStage(rawStage) || rawStage === 'permission';
    const needsFlowV2 = user.onboardingFlowVersion !== 2;
    const timestampChanged =
      String(user.onboardingWelcomeSeenAt ?? null) !==
        String(reconciled.onboardingWelcomeSeenAt) ||
      String(user.onboardingBonusSeenAt ?? null) !== String(reconciled.onboardingBonusSeenAt) ||
      String(user.onboardingPermissionSeenAt ?? null) !==
        String(reconciled.onboardingPermissionSeenAt);

    if (!stageChanged && !timestampChanged && !needsFlowV2) {
      continue;
    }

    if (stageChanged) stageNormalized += 1;
    if (rawStage === 'bonus' && normalizedStage === 'permissions') bonusToPermissions += 1;
    if (needsFlowV2) flowVersionUpgraded += 1;
    if (timestampChanged) timestampsReconciled += 1;
    if (orderCorrections > 0) {
      chronologyClamped += orderCorrections;
      if (sampleFixes.length < 10) {
        sampleFixes.push(`${String(user._id).slice(-6)}: corrections=${orderCorrections}`);
      }
    }

    ops.push({
      updateOne: {
        filter: { _id: user._id },
        update: {
          $set: {
            onboardingStage: normalizedStage,
            onboardingFlowVersion: 2,
            ...reconciledTimestamps,
          },
        },
      },
    });

    if (ops.length >= BATCH_SIZE) {
      if (!dryRun) {
        await User.bulkWrite(ops, { ordered: false });
      }
      ops.length = 0;
    }
  }

  if (ops.length > 0 && !dryRun) {
    await User.bulkWrite(ops, { ordered: false });
  }

  console.log(
    `[RECONCILE] scanned=${scanned} stageNormalized=${stageNormalized} bonusToPermissions=${bonusToPermissions} flowVersionUpgraded=${flowVersionUpgraded} timestampsReconciled=${timestampsReconciled} chronologyClamped=${chronologyClamped} dryRun=${dryRun}`
  );
  if (sampleFixes.length > 0) {
    console.log(`[RECONCILE] sampleFixes=${sampleFixes.join(', ')}`);
  }
  await mongoose.disconnect();
}

main().catch((error) => {
  console.error('[RECONCILE] failed', error);
  process.exit(1);
});
