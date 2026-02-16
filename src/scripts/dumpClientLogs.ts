import env from "../config/env";
import { getRedisClient } from "../lib/redis";
import { listClientLogDevices, pullClientLogs } from "../lib/clientLogs";

async function main() {
  if (!env.DEBUG_CLIENT_LOGS) {
    console.error("DEBUG_CLIENT_LOGS is disabled. Set DEBUG_CLIENT_LOGS=1 in env.");
    process.exit(2);
  }
  const userId = String(process.argv[2] || "").trim();
  const deviceId = String(process.argv[3] || "").trim();
  const limit = Number(process.argv[4] || "200");
  if (!userId) {
    console.error("Usage: ts-node src/scripts/dumpClientLogs.ts <userId> [deviceId] [limit]");
    process.exit(2);
  }
  const redis = await getRedisClient();
  if (!deviceId) {
    const devices = await listClientLogDevices(redis as any, userId);
    console.log(JSON.stringify({ userId, devices }, null, 2));
    return;
  }
  const events = await pullClientLogs(redis as any, userId, deviceId, Number.isFinite(limit) ? limit : 200);
  // print newest first (stored newest first)
  for (const e of events) {
    const ts = typeof e.ts === "number" ? new Date(e.ts).toISOString() : "";
    const line = {
      ts,
      level: e.level,
      tag: e.tag,
      threadId: e.threadId,
      msgId: e.msgId,
      kind: e.kind,
      rootCause: e.rootCause,
      data: e.data,
    };
    console.log(JSON.stringify(line));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

