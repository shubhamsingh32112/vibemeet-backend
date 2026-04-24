require("dotenv").config();
const { StreamChat } = require("stream-chat");

const apiKey = process.env.STREAM_API_KEY;
const apiSecret = process.env.STREAM_API_SECRET;
const BATCH_SIZE = Number(process.env.STREAM_BATCH_SIZE || 100);
const HARD_DELETE = process.env.STREAM_HARD_DELETE === "true";
const DELETE_USERS = process.env.STREAM_DELETE_USERS === "true";
const DRY_RUN = process.env.STREAM_DRY_RUN === "true";
const SHOW_SAMPLE = Number(process.env.STREAM_DRY_RUN_SAMPLE || 10);
const PURGE_ENV = process.env.STREAM_PURGE_ENV || "";
const PURGE_CONFIRM = process.env.STREAM_PURGE_CONFIRM || "";
const REQUIRED_CONFIRM = "DELETE_ALL_STREAM_DATA";
const REQUIRED_ENV = "production";
const MAX_WAIT_MS = Number(process.env.STREAM_TASK_MAX_WAIT_MS || 120000);
const USER_LIST_LIMIT = Number(process.env.STREAM_USER_LIST_LIMIT || 100);
const USER_LIST_OFFSET = Number(process.env.STREAM_USER_LIST_OFFSET || 0);
const USER_DELETE_DELAY_MS = Number(process.env.STREAM_USER_DELETE_DELAY_MS || 250);
const USER_DELETE_MAX_RETRIES = Number(process.env.STREAM_USER_DELETE_MAX_RETRIES || 6);
const USER_DELETE_RETRY_BASE_MS = Number(process.env.STREAM_USER_DELETE_RETRY_BASE_MS || 1500);

if (!apiKey || !apiSecret) {
  console.error("Missing STREAM_API_KEY or STREAM_API_SECRET.");
  process.exit(1);
}

const client = StreamChat.getInstance(apiKey, apiSecret);

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function maskKey(key) {
  if (!key || key.length < 6) return "***";
  return `${key.slice(0, 3)}***${key.slice(-3)}`;
}

function printRunHeader() {
  const mode = DRY_RUN ? "DRY RUN" : "DESTRUCTIVE";
  console.log("==================================================");
  console.log("Stream Chat purge runner");
  console.log(`Timestamp: ${new Date().toISOString()}`);
  console.log(`API Key: ${maskKey(apiKey)}`);
  console.log(`Purge env: ${PURGE_ENV || "<unset>"}`);
  console.log(`Mode: ${mode}`);
  console.log(`Hard delete channels: ${HARD_DELETE}`);
  console.log(`Delete users: ${DELETE_USERS}`);
  console.log(`Batch size: ${BATCH_SIZE}`);
  console.log("==================================================");
}

function assertDestructiveGuards() {
  if (DRY_RUN) return;

  if (PURGE_ENV !== REQUIRED_ENV) {
    console.error(
      `Refusing destructive run: STREAM_PURGE_ENV must be "${REQUIRED_ENV}".`
    );
    process.exit(1);
  }

  if (PURGE_CONFIRM !== REQUIRED_CONFIRM) {
    console.error(
      `Refusing destructive run: STREAM_PURGE_CONFIRM must be "${REQUIRED_CONFIRM}".`
    );
    process.exit(1);
  }
}

async function waitForTask(taskId, maxWaitMs = MAX_WAIT_MS) {
  const pollIntervalMs = 2000;
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const result = await client.getTask(taskId);
    if (result.status === "completed") return result;
    if (result.status === "failed") throw new Error(`Task failed: ${JSON.stringify(result)}`);
    await sleep(pollIntervalMs);
  }
  throw new Error("Task did not complete in time");
}

async function collectChannels({ sampleOnly = false }) {
  const cids = [];
  while (true) {
    const channels = await client.queryChannels({}, {}, { limit: BATCH_SIZE });
    if (!channels.length) break;
    cids.push(...channels.map((ch) => `${ch.type}:${ch.id}`));
    if (sampleOnly && cids.length >= SHOW_SAMPLE) break;
    if (channels.length < BATCH_SIZE) break;
  }
  return cids;
}

async function collectUsers() {
  const users = await client.queryUsers(
    {},
    { id: 1 },
    {
      limit: USER_LIST_LIMIT,
      offset: USER_LIST_OFFSET,
    }
  );
  return (users.users || []).map((u) => u.id).filter(Boolean);
}

async function purgeChannels() {
  let totalDeleted = 0;
  const failures = [];

  while (true) {
    console.log("Fetching channels...");
    const channels = await client.queryChannels({}, {}, { limit: BATCH_SIZE });
    if (!channels.length) {
      console.log("No more channels.");
      break;
    }

    const cids = channels.map((ch) => `${ch.type}:${ch.id}`);
    console.log(
      `Deleting ${cids.length} channels (${HARD_DELETE ? "hard" : "soft"} delete)...`
    );

    try {
      const response = await client.deleteChannels(cids, { hard_delete: HARD_DELETE });
      if (response.task_id) {
        await waitForTask(response.task_id);
      }
      totalDeleted += cids.length;
      console.log(`Deleted batch of ${cids.length} (total: ${totalDeleted}).`);
    } catch (err) {
      failures.push(...cids);
      console.error("Failed deleting channel batch:", err);
    }
  }

  return { totalDeleted, failures };
}

async function purgeUsers() {
  let totalDeleted = 0;
  const failures = new Set();
  let noProgressPasses = 0;
  let pass = 0;

  function isRateLimitError(err) {
    const msg = String(err?.message || "").toLowerCase();
    return (
      msg.includes("too many requests") ||
      String(err?.code || "") === "9" ||
      String(err?.status || "") === "429"
    );
  }

  async function deleteUserWithRetry(userId) {
    for (let attempt = 1; attempt <= USER_DELETE_MAX_RETRIES; attempt += 1) {
      try {
        await client.deleteUser(userId, {
          hard_delete: true,
          mark_messages_deleted: true,
        });
        return true;
      } catch (err) {
        if (!isRateLimitError(err) || attempt === USER_DELETE_MAX_RETRIES) {
          throw err;
        }
        const backoffMs = USER_DELETE_RETRY_BASE_MS * attempt;
        console.warn(
          `Rate limited deleting ${userId}. retry ${attempt}/${USER_DELETE_MAX_RETRIES} after ${backoffMs}ms`
        );
        await sleep(backoffMs);
      }
    }
    return false;
  }

  while (true) {
    pass += 1;
    const users = await collectUsers();
    if (!users.length) {
      console.log("No more users.");
      break;
    }

    console.log(`Pass ${pass}: deleting up to ${users.length} users...`);
    let deletedThisPass = 0;
    for (const userId of users) {
      try {
        await deleteUserWithRetry(userId);
        totalDeleted += 1;
        deletedThisPass += 1;
        failures.delete(userId);
      } catch (err) {
        failures.add(userId);
        console.error(`Failed deleting user ${userId}:`, err.message || err);
      }
      await sleep(USER_DELETE_DELAY_MS);
    }
    console.log(`Deleted users this pass: ${deletedThisPass}; total: ${totalDeleted}`);

    if (deletedThisPass === 0) {
      noProgressPasses += 1;
      console.warn(
        `No progress pass count: ${noProgressPasses}. Possible sustained rate-limit window.`
      );
    } else {
      noProgressPasses = 0;
    }

    if (users.length < USER_LIST_LIMIT) break;
    if (noProgressPasses >= 3) {
      console.error("Stopping user purge after 3 no-progress passes.");
      break;
    }
  }

  return { totalDeleted, failures: Array.from(failures) };
}

async function runDryRun() {
  const channelSample = await collectChannels({ sampleOnly: true });
  const users = await collectUsers();

  console.log("Dry-run summary:");
  console.log(`- Channels sampled: ${channelSample.length}`);
  if (channelSample.length) {
    console.log(
      `- Channel sample IDs: ${channelSample.slice(0, SHOW_SAMPLE).join(", ")}`
    );
  }
  console.log(`- Users listed: ${users.length}`);
  if (users.length) {
    console.log(`- User sample IDs: ${users.slice(0, SHOW_SAMPLE).join(", ")}`);
  }
}

async function resetStream() {
  printRunHeader();
  assertDestructiveGuards();

  try {
    if (DRY_RUN) {
      await runDryRun();
      process.exit(0);
    }

    console.log("Phase 1: deleting channels...");
    const channelResult = await purgeChannels();
    console.log(
      `Channel purge complete. deleted=${channelResult.totalDeleted}, failures=${channelResult.failures.length}`
    );

    let userResult = { totalDeleted: 0, failures: [] };
    if (DELETE_USERS) {
      console.log("Phase 2: deleting users...");
      userResult = await purgeUsers();
      console.log(
        `User purge complete. deleted=${userResult.totalDeleted}, failures=${userResult.failures.length}`
      );
    } else {
      console.log("Skipping user deletion (STREAM_DELETE_USERS !== true).");
    }

    if (channelResult.failures.length || userResult.failures.length) {
      console.error("Purge completed with failures.");
      if (channelResult.failures.length) {
        console.error("Failed channels:", channelResult.failures.join(", "));
      }
      if (userResult.failures.length) {
        console.error("Failed users:", userResult.failures.join(", "));
      }
      process.exit(1);
    }

    console.log("Purge complete with zero failures.");
    process.exit(0);
  } catch (err) {
    console.error("Purge failed:", err);
    process.exit(1);
  }
}

resetStream();
