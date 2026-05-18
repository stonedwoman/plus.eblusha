import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { io as ioClient, type Socket } from "socket.io-client";
import { getRedisClient } from "../src/lib/redis";
import prisma from "../src/lib/prisma";
import { signAccessToken } from "../src/utils/jwt";

type StartedChild = { proc: ChildProcess; baseUrl: string; port: number };

const TS_NODE_BIN = path.resolve(__dirname, "..", "node_modules", ".bin", "ts-node");
const INSTANCE_ENTRY = path.resolve(__dirname, "fixtures", "presence-instance.ts");

function wait(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function startPresenceInstance(name: string): Promise<StartedChild> {
  const proc = spawn(TS_NODE_BIN, [INSTANCE_ENTRY], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PORT: "0" },
  });

  let stdout = "";
  let stderr = "";

  if (!proc.stdout || !proc.stderr) {
    throw new Error(`${name}: failed to spawn (no stdio)`);
  }

  proc.stdout.setEncoding("utf8");
  proc.stderr.setEncoding("utf8");
  proc.stdout.on("data", (d) => (stdout += d));
  proc.stderr.on("data", (d) => (stderr += d));

  const port = await new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`${name}: timeout waiting READY. stdout=${stdout} stderr=${stderr}`));
    }, 30_000);

    const onData = (chunk: string) => {
      const lines = chunk.split("\n");
      for (const lineRaw of lines) {
        const line = lineRaw.trim();
        if (!line) continue;
        const m = /^PRESENCE_INSTANCE_READY\s+(\d+)$/.exec(line);
        if (m) {
          clearTimeout(timeout);
          proc.stdout.off("data", onData);
          resolve(Number(m[1]));
          return;
        }
      }
    };
    proc.stdout.on("data", onData);

    proc.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`${name}: exited early (${code}). stdout=${stdout} stderr=${stderr}`));
    });
  });

  return { proc, port, baseUrl: `http://127.0.0.1:${port}` };
}

async function stopChild(child: StartedChild) {
  if (child.proc.killed) return;
  child.proc.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.proc.once("exit", () => resolve())),
    wait(10_000),
  ]);
}

async function waitFor<T>(fn: () => T | Promise<T>, predicate: (v: T) => boolean, timeoutMs: number) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = await fn();
    if (predicate(v)) return v;
    await wait(50);
  }
  throw new Error("waitFor: timeout");
}

async function connectSocket(baseUrl: string, token: string): Promise<Socket> {
  const socket = ioClient(baseUrl, {
    auth: { token },
    transports: ["websocket"],
    forceNew: true,
    reconnection: false,
  });
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("socket connect timeout")), 10_000);
    socket.once("connect", () => {
      clearTimeout(t);
      resolve();
    });
    socket.once("connect_error", (err) => {
      clearTimeout(t);
      reject(err);
    });
  });
  return socket;
}

async function createUser(username: string) {
  return prisma.user.create({
    data: {
      username,
      passwordHash: `hash_${username}_${randomUUID()}`,
    },
  });
}

async function runPresenceDisconnectKeepsOnlineTest(a: StartedChild, b: StartedChild) {
  const userId = `presence_test_user_${Date.now()}`;
  const token = signAccessToken({ sub: userId, tokenId: `tok-${Date.now()}` });

  const redis = await getRedisClient();
  const presenceSetKey = `presence_socks:${userId}`;
  const activeSetKey = `active_socks:${userId}`;

  let socketA: Socket | null = null;
  let socketB: Socket | null = null;

  try {
    socketA = await connectSocket(a.baseUrl, token);
    socketB = await connectSocket(b.baseUrl, token);

    let lastB: string | null = null;
    const historyB: string[] = [];
    socketB.on("presence:update", (p: any) => {
      if (p?.userId === userId && typeof p?.status === "string") {
        lastB = p.status;
        historyB.push(p.status);
      }
    });

    // Make both sockets "active".
    socketA.emit("presence:state", { active: true, visibility: "visible", source: "web" });
    socketB.emit("presence:state", { active: true, visibility: "visible", source: "web" });

    await waitFor(
      () => lastB,
      (v) => v === "ONLINE" || v === "IN_CALL",
      8_000
    );

    await waitFor(
      async () => ({ p: await redis.sCard(presenceSetKey), a: await redis.sCard(activeSetKey) }),
      (v) => v.p >= 2 && v.a >= 2,
      8_000
    );

    // Disconnect instance A socket, instance B should keep user ONLINE/active.
    socketA.disconnect();
    socketA = null;
    await wait(600);

    const afterPresence = await redis.sCard(presenceSetKey);
    const afterActive = await redis.sCard(activeSetKey);
    assert.equal(afterPresence, 1, "presence_socks should still contain 1 live socket after A disconnect");
    assert.equal(afterActive, 1, "active_socks should still contain 1 live active socket after A disconnect");

    // Ensure B did not observe OFFLINE.
    assert.equal(historyB.includes("OFFLINE"), false, `unexpected OFFLINE on B. history=${historyB.join(",")}`);
    assert.notEqual(lastB, "OFFLINE");
  } finally {
    try {
      socketA?.disconnect();
    } catch {}
    try {
      socketB?.disconnect();
    } catch {}
  }
}

async function runInCallOverrideAcrossInstancesTest(a: StartedChild, b: StartedChild) {
  const alice = await createUser(`presence_obs_${Date.now()}`);
  const bob = await createUser(`presence_call_${Date.now()}`);
  const conversationId = `presence-call-${randomUUID()}`;
  await prisma.conversation.create({
    data: {
      id: conversationId,
      isGroup: false,
      createdById: alice.id,
      participants: {
        create: [{ userId: alice.id }, { userId: bob.id }],
      },
    },
  });

  const aliceToken = signAccessToken({ sub: alice.id, tokenId: `tok-${randomUUID()}` });
  const bobToken = signAccessToken({ sub: bob.id, tokenId: `tok-${randomUUID()}` });

  let observer: Socket | null = null;
  let bobBackgroundSocket: Socket | null = null;
  let bobCallSocket: Socket | null = null;

  try {
    observer = await connectSocket(a.baseUrl, aliceToken);
    bobBackgroundSocket = await connectSocket(a.baseUrl, bobToken);
    bobCallSocket = await connectSocket(b.baseUrl, bobToken);

    let lastBobStatus: string | null = null;
    const bobHistory: string[] = [];
    observer.on("presence:update", (payload: any) => {
      if (payload?.userId === bob.id && typeof payload?.status === "string") {
        lastBobStatus = payload.status;
        bobHistory.push(payload.status);
      }
    });

    bobBackgroundSocket.emit("presence:state", { active: false, visibility: "hidden", source: "web" });
    bobCallSocket.emit("presence:state", { active: false, visibility: "hidden", source: "web" });
    bobCallSocket.emit("call:room:join", { conversationId, video: false });

    await waitFor(
      () => lastBobStatus,
      (status) => status === "IN_CALL",
      8_000
    );

    const historyAfterJoin = bobHistory.length;
    bobBackgroundSocket.emit("presence:state", { active: false, visibility: "hidden", source: "web" });
    await wait(600);

    assert.equal(
      bobHistory.slice(historyAfterJoin).includes("BACKGROUND"),
      false,
      `unexpected BACKGROUND after remote presence recompute. history=${bobHistory.join(",")}`
    );
    assert.equal(lastBobStatus, "IN_CALL");

    bobCallSocket.emit("call:room:leave", { conversationId });
    await waitFor(
      () => lastBobStatus,
      (status) => status === "BACKGROUND",
      8_000
    );
  } finally {
    try {
      observer?.disconnect();
    } catch {}
    try {
      bobBackgroundSocket?.disconnect();
    } catch {}
    try {
      bobCallSocket?.disconnect();
    } catch {}
  }
}

async function runDirectAcceptInCallOverrideAcrossInstancesTest(a: StartedChild, b: StartedChild) {
  const alice = await createUser(`presence_direct_obs_${Date.now()}`);
  const bob = await createUser(`presence_direct_call_${Date.now()}`);
  const conversationId = `presence-direct-call-${randomUUID()}`;
  await prisma.conversation.create({
    data: {
      id: conversationId,
      isGroup: false,
      createdById: alice.id,
      participants: {
        create: [{ userId: alice.id }, { userId: bob.id }],
      },
    },
  });

  const aliceToken = signAccessToken({ sub: alice.id, tokenId: `tok-${randomUUID()}` });
  const bobToken = signAccessToken({ sub: bob.id, tokenId: `tok-${randomUUID()}` });

  let aliceSocket: Socket | null = null;
  let bobBackgroundSocket: Socket | null = null;
  let bobAcceptSocket: Socket | null = null;

  try {
    aliceSocket = await connectSocket(a.baseUrl, aliceToken);
    bobBackgroundSocket = await connectSocket(a.baseUrl, bobToken);
    bobAcceptSocket = await connectSocket(b.baseUrl, bobToken);

    let lastBobStatus: string | null = null;
    const bobHistory: string[] = [];
    aliceSocket.on("presence:update", (payload: any) => {
      if (payload?.userId === bob.id && typeof payload?.status === "string") {
        lastBobStatus = payload.status;
        bobHistory.push(payload.status);
      }
    });

    bobBackgroundSocket.emit("presence:state", { active: false, visibility: "hidden", source: "web" });
    bobAcceptSocket.emit("presence:state", { active: false, visibility: "hidden", source: "web" });

    const incomingPromise = new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("call:incoming timeout")), 8_000);
      bobAcceptSocket?.once("call:incoming", (payload) => {
        clearTimeout(timeout);
        resolve(payload);
      });
    });

    aliceSocket.emit("call:invite", { conversationId, video: false });
    await incomingPromise;

    bobAcceptSocket.emit("call:accept", { conversationId, video: false });

    await waitFor(
      () => lastBobStatus,
      (status) => status === "IN_CALL",
      8_000
    );

    const historyAfterAccept = bobHistory.length;
    bobBackgroundSocket.emit("presence:state", { active: false, visibility: "hidden", source: "web" });
    await wait(600);

    assert.equal(
      bobHistory.slice(historyAfterAccept).includes("BACKGROUND"),
      false,
      `unexpected BACKGROUND after direct call accept. history=${bobHistory.join(",")}`
    );
    assert.equal(
      bobHistory.slice(historyAfterAccept).includes("ONLINE"),
      false,
      `unexpected ONLINE after direct call accept. history=${bobHistory.join(",")}`
    );
    assert.equal(lastBobStatus, "IN_CALL");

    aliceSocket.emit("call:end", { conversationId });
    await wait(400);
  } finally {
    try {
      aliceSocket?.disconnect();
    } catch {}
    try {
      bobBackgroundSocket?.disconnect();
    } catch {}
    try {
      bobAcceptSocket?.disconnect();
    } catch {}
  }
}

async function main() {
  const a = await startPresenceInstance("A");
  const b = await startPresenceInstance("B");
  try {
    await runPresenceDisconnectKeepsOnlineTest(a, b);
    await runInCallOverrideAcrossInstancesTest(a, b);
    await runDirectAcceptInCallOverrideAcrossInstancesTest(a, b);
  } finally {
    await stopChild(a);
    await stopChild(b);
    await prisma.$disconnect();
  }
}

void main().then(
  () => {
    // eslint-disable-next-line no-console
    console.log("presence-multi-instance: ok");
    process.exit(0);
  },
  (err) => {
    // eslint-disable-next-line no-console
    console.error("presence-multi-instance: failed", err);
    process.exit(1);
  }
);

