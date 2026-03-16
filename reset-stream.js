require("dotenv").config();
const { StreamChat } = require("stream-chat");

const apiKey = process.env.STREAM_API_KEY;
const apiSecret = process.env.STREAM_API_SECRET;
const BATCH_SIZE = 100;
const HARD_DELETE = process.env.STREAM_HARD_DELETE === "true";

const client = StreamChat.getInstance(apiKey, apiSecret);

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForTask(taskId, maxWaitMs = 60000) {
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

async function resetStream() {
  try {
    let totalDeleted = 0;

    while (true) {
      console.log("Fetching channels...");
      const channels = await client.queryChannels({}, {}, { limit: BATCH_SIZE });
      if (channels.length === 0) {
        console.log("No more channels.");
        break;
      }

      const cids = channels.map((ch) => `${ch.type}:${ch.id}`);
      console.log(`Deleting ${cids.length} channels (${HARD_DELETE ? "hard" : "soft"} delete)...`);

      const response = await client.deleteChannels(cids, { hard_delete: HARD_DELETE });
      if (response.task_id) {
        await waitForTask(response.task_id);
      }
      totalDeleted += cids.length;
      console.log(`Deleted batch of ${cids.length} (total: ${totalDeleted}).`);
    }

    console.log("All channels deleted.");
    process.exit(0);
  } catch (err) {
    console.error("Error deleting channels:", err);
    process.exit(1);
  }
}

resetStream();
