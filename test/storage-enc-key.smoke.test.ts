import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";

const TS_NODE_BIN = path.resolve(__dirname, "..", "node_modules", ".bin", "ts-node");
const REQUIRE_ENV_ENTRY = path.resolve(__dirname, "fixtures", "require-env.ts");

async function run() {
  const proc = spawn(TS_NODE_BIN, [REQUIRE_ENV_ENTRY], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      NODE_ENV: "production",
      // Ensure dotenv does NOT overwrite it from .env
      STORAGE_ENC_KEY: "",
    },
  });

  let stdout = "";
  let stderr = "";
  proc.stdout.setEncoding("utf8");
  proc.stderr.setEncoding("utf8");
  proc.stdout.on("data", (d) => (stdout += d));
  proc.stderr.on("data", (d) => (stderr += d));

  const code: number = await new Promise((resolve) => proc.once("exit", (c) => resolve(c ?? 0)));

  assert.notEqual(code, 0, `expected non-zero exit. stdout=${stdout} stderr=${stderr}`);
  assert.equal(
    (stdout + stderr).includes("STORAGE_ENC_KEY"),
    true,
    `expected STORAGE_ENC_KEY error. stdout=${stdout} stderr=${stderr}`
  );
}

void run().then(
  () => {
    // eslint-disable-next-line no-console
    console.log("storage-enc-key: ok");
    process.exit(0);
  },
  (err) => {
    // eslint-disable-next-line no-console
    console.error("storage-enc-key: failed", err);
    process.exit(1);
  }
);

