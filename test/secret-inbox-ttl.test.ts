import assert from "node:assert/strict";
import {
  DEFAULT_SECRET_MESSAGE_TTL_SECONDS,
  SECRET_MESSAGE_TTL_MAX_SECONDS,
  enqueueSecretMessages,
} from "../src/lib/secretInbox";

function makeRedisMock() {
  return {
    set: async () => null,
    rPush: async () => 0,
    expire: async () => 0,
    lRange: async () => [],
    mGet: async () => [],
    del: async () => 0,
    lRem: async () => 0,
    eval: async () => 1,
  };
}

async function getTtlSecondsFromEnqueue(envValue?: string, rawTtlSeconds?: number) {
  const prev = process.env.SECRET_MESSAGE_TTL_SECONDS;
  try {
    if (typeof envValue === "string") process.env.SECRET_MESSAGE_TTL_SECONDS = envValue;
    else delete process.env.SECRET_MESSAGE_TTL_SECONDS;

    const [res] = await enqueueSecretMessages(makeRedisMock() as any, [
      {
        toDeviceId: "dev1",
        msgId: "m1",
        payload: { kind: "test", v: 1 },
        ...(typeof rawTtlSeconds === "number" ? { ttlSeconds: rawTtlSeconds } : {}),
      },
    ]);
    assert.ok(res);
    return res.ttlSeconds;
  } finally {
    if (typeof prev === "string") process.env.SECRET_MESSAGE_TTL_SECONDS = prev;
    else delete process.env.SECRET_MESSAGE_TTL_SECONDS;
  }
}

async function main() {
  // no env -> default
  assert.equal(await getTtlSecondsFromEnqueue(undefined), DEFAULT_SECRET_MESSAGE_TTL_SECONDS);

  // env override
  assert.equal(await getTtlSecondsFromEnqueue("1800"), 1800);

  // clamp max
  assert.equal(await getTtlSecondsFromEnqueue("999999999"), SECRET_MESSAGE_TTL_MAX_SECONDS);
}

void main().then(
  () => {
    // eslint-disable-next-line no-console
    console.log("secret-inbox-ttl: ok");
  },
  (err) => {
    // eslint-disable-next-line no-console
    console.error("secret-inbox-ttl: failed", err);
    process.exit(1);
  }
);

