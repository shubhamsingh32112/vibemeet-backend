import { logInfo } from '../utils/logger';

function parseTaskIdFromArn(taskArn: string): string {
  const trimmed = taskArn.trim();
  if (!trimmed) return trimmed;
  const slash = trimmed.lastIndexOf('/');
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

/** Resolve BILLING_INSTANCE_ID from ECS task metadata when not explicitly set. */
export async function resolveBillingInstanceIdFromEcs(): Promise<void> {
  if (process.env.BILLING_INSTANCE_ID?.trim()) return;

  const metadataUri = process.env.ECS_CONTAINER_METADATA_URI_V4?.trim();
  if (!metadataUri) return;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);

  try {
    const res = await fetch(`${metadataUri}/task`, { signal: controller.signal });
    if (!res.ok) return;
    const body = (await res.json()) as { TaskARN?: string };
    const taskArn = body.TaskARN?.trim();
    if (!taskArn) return;
    process.env.BILLING_INSTANCE_ID = parseTaskIdFromArn(taskArn);
    logInfo('billing.instance_id.resolved', {
      source: 'ecs_metadata_v4',
      billingInstanceId: process.env.BILLING_INSTANCE_ID,
    });
  } catch {
    // fallback to hostname:pid in getBillingInstanceId()
  } finally {
    clearTimeout(timer);
  }
}
