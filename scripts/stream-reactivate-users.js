require('dotenv').config();
const { StreamChat } = require('stream-chat');

const apiKey = process.env.STREAM_API_KEY;
const apiSecret = process.env.STREAM_API_SECRET;
const BATCH_SIZE = Number(process.env.STREAM_REACTIVATE_BATCH_SIZE || 100);
const ONLY_DEACTIVATED = process.env.STREAM_REACTIVATE_ONLY_DEACTIVATED !== 'false';
const DRY_RUN = process.env.STREAM_DRY_RUN === 'true';

if (!apiKey || !apiSecret) {
  console.error('Missing STREAM_API_KEY or STREAM_API_SECRET.');
  process.exit(1);
}

const client = StreamChat.getInstance(apiKey, apiSecret);

async function listUsers(offset) {
  const response = await client.queryUsers(
    {},
    { id: 1 },
    {
      include_deactivated_users: true,
      include_deleted_users: true,
      limit: BATCH_SIZE,
      offset,
    },
  );
  return response.users || [];
}

async function reactivateBatch(ids) {
  if (!ids.length) return;
  await client.reactivateUsers(ids, {
    restore_messages: true,
  });
}

async function run() {
  console.log('==============================================');
  console.log('Stream bulk user reactivation');
  console.log(`Timestamp: ${new Date().toISOString()}`);
  console.log(`Batch size: ${BATCH_SIZE}`);
  console.log(`Only deactivated/deleted: ${ONLY_DEACTIVATED}`);
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'DESTRUCTIVE'}`);
  console.log('==============================================');

  let offset = 0;
  let scanned = 0;
  let targeted = 0;
  let processed = 0;
  const failures = [];

  while (true) {
    const users = await listUsers(offset);
    if (!users.length) break;

    scanned += users.length;
    const ids = users
      .filter((u) => {
        if (!ONLY_DEACTIVATED) return true;
        return Boolean(u.deactivated_at || u.deleted_at);
      })
      .map((u) => u.id)
      .filter(Boolean);

    targeted += ids.length;

    if (DRY_RUN) {
      console.log(`Scanned batch at offset ${offset}: ${users.length}, targeted: ${ids.length}`);
    } else if (ids.length) {
      try {
        await reactivateBatch(ids);
        processed += ids.length;
        console.log(`Reactivated batch at offset ${offset}: ${ids.length}`);
      } catch (err) {
        failures.push(...ids);
        console.error(`Failed reactivating batch at offset ${offset}:`, err.message || err);
      }
    }

    if (users.length < BATCH_SIZE) break;
    offset += BATCH_SIZE;
  }

  console.log('----------------------------------------------');
  console.log(`Users scanned: ${scanned}`);
  console.log(`Users targeted: ${targeted}`);
  console.log(`Users reactivated: ${processed}`);
  console.log(`Failures: ${failures.length}`);
  if (failures.length) {
    console.log(`Failure IDs: ${failures.join(', ')}`);
  }
  console.log('----------------------------------------------');

  if (failures.length) process.exit(1);
  process.exit(0);
}

run().catch((err) => {
  console.error('Reactivation script failed:', err);
  process.exit(1);
});
