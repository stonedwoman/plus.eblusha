import { createClient } from "redis";
import env from "../config/env";
import logger from "../config/logger";

export type RedisClient = ReturnType<typeof createClient>;

let sharedClient: RedisClient | null = null;
let sharedConnectPromise: Promise<RedisClient> | null = null;

export async function getRedisClient(): Promise<RedisClient> {
  if (sharedClient) return sharedClient;
  if (sharedConnectPromise) return sharedConnectPromise;

  const client = createClient({ url: env.REDIS_URL });
  client.on("error", (err) => {
    logger.error({ err }, "Redis error");
  });

  const p = client
    .connect()
    .then(() => {
      sharedClient = client;
      return client;
    })
    .finally(() => {
      sharedConnectPromise = null;
    });
  sharedConnectPromise = p;

  return p;
}

export async function createDedicatedRedisClient(): Promise<RedisClient> {
  const client = createClient({ url: env.REDIS_URL });
  client.on("error", (err) => {
    logger.error({ err }, "Redis error");
  });
  await client.connect();
  return client;
}

