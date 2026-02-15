import axios from "axios";
import { io as ioClient, type Socket } from "socket.io-client";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

type StartedServer = { child: ChildProcessWithoutNullStreams; logs: string[]; port: number };

async function waitForHealth(srv: StartedServer, timeoutMs: number) {
  const base = `http://localhost:${srv.port}`;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (srv.child.exitCode !== null) {
      throw new Error(`server ${srv.port} exited early (code=${srv.child.exitCode}). logs:\n${srv.logs.join("")}`);
    }
    try {
      const r = await axios.get(`${base}/health`, { timeout: 1000 });
      if (r.status === 200) return;
    } catch {}
    await sleep(250);
  }
  throw new Error(`server ${srv.port} health timeout. logs:\n${srv.logs.join("")}`);
}

function startServer(port: number, extraEnv: Record<string, string>): StartedServer {
  const child = spawn(process.execPath, ["-r", "ts-node/register", "src/server.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), ...extraEnv },
    stdio: "pipe",
  });
  const logs: string[] = [];
  const push = (chunk: any) => {
    try {
      logs.push(String(chunk));
      if (logs.length > 200) logs.shift();
    } catch {}
  };
  child.stderr.on("data", push);
  child.stdout.on("data", push);
  return { child, logs, port };
}

async function connectSocket(baseUrl: string, token: string): Promise<Socket> {
  return await new Promise((resolve, reject) => {
    const s = ioClient(baseUrl, {
      transports: ["websocket"],
      auth: { token },
      query: { token },
    });
    const t = setTimeout(() => reject(new Error("socket connect timeout")), 5000);
    s.on("connect", () => {
      clearTimeout(t);
      resolve(s);
    });
    s.on("connect_error", (err) => {
      clearTimeout(t);
      reject(err);
    });
  });
}

async function main() {
  const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
  const DATABASE_URL = process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/eblusha";

  const commonEnv = {
    NODE_ENV: "test",
    REDIS_URL,
    DATABASE_URL,
    JWT_SECRET: process.env.JWT_SECRET || "test_jwt_secret________________________________",
    JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET || "test_jwt_refresh_secret________________________",
    LIVEKIT_URL: process.env.LIVEKIT_URL || "wss://example.com",
    LIVEKIT_API_KEY: process.env.LIVEKIT_API_KEY || "test",
    LIVEKIT_API_SECRET: process.env.LIVEKIT_API_SECRET || "test",
    LOG_LEVEL: "warn",
  };

  const port1 = 4100;
  const port2 = 4101;

  const s1 = startServer(port1, commonEnv);
  const s2 = startServer(port2, commonEnv);

  try {
    await Promise.all([waitForHealth(s1, 20_000), waitForHealth(s2, 20_000)]);

    const api = axios.create({ baseURL: `http://localhost:${port1}/api`, timeout: 10_000 });
    const usernameA = `smoke_a_${Date.now()}`;
    const usernameB = `smoke_b_${Date.now()}`;
    const password = "Password123!";

    await api.post("/auth/register", { username: usernameA, password, displayName: "Smoke A" });
    await api.post("/auth/register", { username: usernameB, password, displayName: "Smoke B" });

    const loginA = await api.post("/auth/login", { username: usernameA, password });
    const loginB = await api.post("/auth/login", { username: usernameB, password });

    const tokenA = loginA.data.accessToken as string;
    const tokenB = loginB.data.accessToken as string;
    const userA = loginA.data.user as { id: string };
    const userB = loginB.data.user as { id: string };
    assert.ok(tokenA && tokenB && userA?.id && userB?.id);

    const convResp = await api.post(
      "/conversations",
      { participantIds: [userB.id], isGroup: false },
      { headers: { Authorization: `Bearer ${tokenA}` } }
    );
    const conversationId = convResp.data.conversation.id as string;
    assert.ok(conversationId);

    const socketA = await connectSocket(`http://localhost:${port1}`, tokenA);
    const socketB = await connectSocket(`http://localhost:${port2}`, tokenB);

    try {
      // Join conversation room on both instances.
      socketA.emit("conversation:join", conversationId);
      socketB.emit("conversation:join", conversationId);

      // Multi-instance adapter smoke: typing from instance2 should reach instance1.
      const typingSeen = await new Promise<boolean>((resolve) => {
        const t = setTimeout(() => resolve(false), 5000);
        socketA.on("conversation:typing", (p: any) => {
          if (p?.conversationId === conversationId && p?.userId === userB.id && p?.typing === true) {
            clearTimeout(t);
            resolve(true);
          }
        });
        socketB.emit("conversation:typing", { conversationId, typing: true });
      });
      assert.equal(typingSeen, true, "typing event should cross instances via Redis adapter");

      // Link preview smoke: send message with URL, wait for message:update.
      const sendResp = await api.post(
        "/conversations/send",
        { conversationId, type: "TEXT", content: "check https://example.com" },
        { headers: { Authorization: `Bearer ${tokenA}` } }
      );
      const messageId = sendResp.data.message.id as string;
      assert.ok(messageId);

      const previewUpdated = await new Promise<boolean>((resolve) => {
        const t = setTimeout(() => resolve(false), 15_000);
        socketA.on("message:update", (p: any) => {
          if (p?.conversationId === conversationId && p?.messageId === messageId && p?.reason === "link_preview") {
            clearTimeout(t);
            resolve(true);
          }
        });
      });
      assert.equal(previewUpdated, true, "link preview worker should emit message:update");
    } finally {
      socketA.close();
      socketB.close();
    }
  } finally {
    try { s1.child.kill("SIGTERM"); } catch {}
    try { s2.child.kill("SIGTERM"); } catch {}
  }

  // eslint-disable-next-line no-console
  console.log("platform-smoke: ok");
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error("platform-smoke: fail", e);
  process.exit(1);
});

