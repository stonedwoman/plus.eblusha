import IORedis from "ioredis";
import env from "../config/env";

export const MESSAGE_UPDATE_CHANNEL = "realtime:message:update";

export type RealtimeMessageUpdatePayload = {
  conversationId: string;
  messageId: string;
  reason: string;
  message?: unknown;
};

let pubConnection: IORedis | null = null;

function getPubConnection(): IORedis {
  if (pubConnection) return pubConnection;
  pubConnection = new IORedis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  });
  return pubConnection;
}

export async function publishMessageUpdate(payload: RealtimeMessageUpdatePayload): Promise<void> {
  const conn = getPubConnection();
  await conn.publish(MESSAGE_UPDATE_CHANNEL, JSON.stringify(payload));
}
