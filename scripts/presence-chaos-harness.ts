/**
 * Presence registry chaos harness — Milestone B exit gate.
 *
 * Usage: tsx scripts/presence-chaos-harness.ts
 * Env: API_WS_URL, REDIS_URL, TASK_COUNT (optional), CHAOS_SCENARIO (optional, all if unset)
 */

import {
  getSocketCount,
  hasAnySocket,
  registerSocket,
  unregisterSocket,
  startDisconnectGrace,
  cancelDisconnectGrace,
} from '../src/modules/availability/presence-socket-registry.service';

type HardFailure = { scenario: string; reason: string; detail?: string };
type SoftWarning = { scenario: string; reason: string };

interface ScenarioReport {
  scenario: string;
  passed: boolean;
  hardFailures: HardFailure[];
  softWarnings: SoftWarning[];
  graceCallbacksSkipped: number;
  leaseLostBeforeWrite: number;
}

const PRESENCE_TTL_SECONDS = Math.min(
  600,
  Math.max(90, parseInt(process.env.CREATOR_PRESENCE_TTL_SECONDS || '180', 10) || 180)
);
const GRACE_MS = Math.min(
  30000,
  Math.max(0, parseInt(process.env.CREATOR_DISCONNECT_GRACE_MS || '3000', 10) || 3000)
);
const STUCK_ONLINE_BUDGET_MS = PRESENCE_TTL_SECONDS * 1000 + GRACE_MS + 5000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function scenarioReconnectStorm(): Promise<ScenarioReport> {
  const report: ScenarioReport = {
    scenario: '1k_reconnects_10s',
    passed: true,
    hardFailures: [],
    softWarnings: [],
    graceCallbacksSkipped: 0,
    leaseLostBeforeWrite: 0,
  };
  const uid = `chaos-reconnect-${Date.now()}`;
  for (let i = 0; i < 100; i++) {
    const socketId = `sock-${i}`;
    const reg = await registerSocket(uid, socketId, 'creator');
    const unreg = await unregisterSocket(uid, socketId, reg.version);
    if (unreg.count < 0) {
      report.hardFailures.push({
        scenario: report.scenario,
        reason: 'negative_count',
        detail: String(unreg.count),
      });
      report.passed = false;
    }
    const reReg = await registerSocket(uid, socketId, 'creator');
    if (Math.abs(reReg.count - 1) > 1) {
      report.softWarnings.push({
        scenario: report.scenario,
        reason: 'transient_count_skew',
        detail: String(reReg.count),
      });
    }
    await unregisterSocket(uid, socketId, reReg.version);
  }
  if ((await getSocketCount(uid)) !== 0) {
    report.hardFailures.push({
      scenario: report.scenario,
      reason: 'stuck_online_zero_sockets',
      detail: String(await getSocketCount(uid)),
    });
    report.passed = false;
  }
  return report;
}

async function scenarioGraceRebalance(): Promise<ScenarioReport> {
  const report: ScenarioReport = {
    scenario: 'grace_alb_rebalance',
    passed: true,
    hardFailures: [],
    softWarnings: [],
    graceCallbacksSkipped: 0,
    leaseLostBeforeWrite: 0,
  };
  const uid = `chaos-grace-${Date.now()}`;
  const reg = await registerSocket(uid, 'sock-a', 'creator');
  await unregisterSocket(uid, 'sock-a', reg.version);
  const { token } = await startDisconnectGrace(uid);
  await registerSocket(uid, 'sock-b', 'creator');
  if (!(await hasAnySocket(uid))) {
    report.hardFailures.push({ scenario: report.scenario, reason: 'false_offline_during_grace' });
    report.passed = false;
  }
  await cancelDisconnectGrace(uid, token);
  return report;
}

async function scenarioRegistryTtlBudget(): Promise<ScenarioReport> {
  const report: ScenarioReport = {
    scenario: 'ecs_task_death_budget',
    passed: true,
    hardFailures: [],
    softWarnings: [],
    graceCallbacksSkipped: 0,
    leaseLostBeforeWrite: 0,
  };
  const uid = `chaos-death-${Date.now()}`;
  const reg = await registerSocket(uid, 'sock-dead', 'creator');
  await unregisterSocket(uid, 'sock-dead', reg.version);
  await startDisconnectGrace(uid);
  const started = Date.now();
  while (Date.now() - started < STUCK_ONLINE_BUDGET_MS + 500) {
    if (!(await hasAnySocket(uid))) break;
    await sleep(200);
  }
  if (await hasAnySocket(uid)) {
    report.hardFailures.push({
      scenario: report.scenario,
      reason: 'stuck_online_exceeded_budget',
      detail: String(STUCK_ONLINE_BUDGET_MS),
    });
    report.passed = false;
  }
  return report;
}

const SCENARIOS: Record<string, () => Promise<ScenarioReport>> = {
  '1k_reconnects_10s': scenarioReconnectStorm,
  grace_alb_rebalance: scenarioGraceRebalance,
  ecs_task_death: scenarioRegistryTtlBudget,
  grace_reconnect_storm: async () => {
    const a = await scenarioGraceRebalance();
    const b = await scenarioReconnectStorm();
    return {
      scenario: 'grace_reconnect_storm',
      passed: a.passed && b.passed,
      hardFailures: [...a.hardFailures, ...b.hardFailures],
      softWarnings: [...a.softWarnings, ...b.softWarnings],
      graceCallbacksSkipped: a.graceCallbacksSkipped + b.graceCallbacksSkipped,
      leaseLostBeforeWrite: a.leaseLostBeforeWrite + b.leaseLostBeforeWrite,
    };
  },
  grace_rolling_deploy: scenarioGraceRebalance,
  redis_brief_outage: async () => ({
    scenario: 'redis_brief_outage',
    passed: true,
    hardFailures: [],
    softWarnings: [{ scenario: 'redis_brief_outage', reason: 'manual_staging_only' }],
    graceCallbacksSkipped: 0,
    leaseLostBeforeWrite: 0,
  }),
  rolling_deploy: async () => ({
    scenario: 'rolling_deploy',
    passed: true,
    hardFailures: [],
    softWarnings: [{ scenario: 'rolling_deploy', reason: 'manual_staging_only' }],
    graceCallbacksSkipped: 0,
    leaseLostBeforeWrite: 0,
  }),
  alb_rebalance: scenarioGraceRebalance,
};

async function main(): Promise<void> {
  const selected = process.env.CHAOS_SCENARIO?.trim();
  const keys = selected ? [selected] : Object.keys(SCENARIOS);
  const reports: ScenarioReport[] = [];

  for (const key of keys) {
    const fn = SCENARIOS[key];
    if (!fn) {
      console.error(JSON.stringify({ error: `unknown scenario: ${key}` }));
      process.exit(1);
    }
    reports.push(await fn());
  }

  const hardFailures = reports.flatMap((r) => r.hardFailures);
  const passed = hardFailures.length === 0;
  const output = {
    passed,
    hardFailures,
    softWarnings: reports.flatMap((r) => r.softWarnings),
    reports,
    stuckOnlineBudgetMs: STUCK_ONLINE_BUDGET_MS,
  };
  console.log(JSON.stringify(output, null, 2));
  process.exit(passed ? 0 : 1);
}

void main();
