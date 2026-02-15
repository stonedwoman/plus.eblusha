import { spawn } from "node:child_process";

function run(cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: "inherit",
      env: { ...process.env, ...(opts.env ?? {}) },
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(" ")} exited with code ${code}`));
    });
  });
}

function runCapture(cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv } = {}): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...(opts.env ?? {}) },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.on("exit", (code) => resolve({ stdout, stderr, code: code ?? 1 }));
    child.on("error", (err) => resolve({ stdout, stderr: `${stderr}\n${String(err)}`, code: 1 }));
  });
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

async function waitForRedisWithProject(composeFile: string, project: string) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const r = await runCapture("docker", ["compose", "-p", project, "-f", composeFile, "exec", "-T", "redis", "redis-cli", "ping"]);
    if (r.code === 0 && r.stdout.trim().toUpperCase() === "PONG") return;
    await sleep(500);
  }

  // surface useful diagnostics
  // eslint-disable-next-line no-console
  console.error("[smoke] redis did not become healthy in time. redis logs:");
  await run("docker", ["compose", "-p", project, "-f", composeFile, "logs", "--no-color", "--tail", "200", "redis"]).catch(() => {});
  throw new Error("redis healthcheck timeout");
}

async function waitForPostgresWithProject(composeFile: string, project: string) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const r = await runCapture("docker", [
      "compose",
      "-p",
      project,
      "-f",
      composeFile,
      "exec",
      "-T",
      "postgres",
      "pg_isready",
      "-U",
      "eblusha",
      "-d",
      "eblusha_smoke",
    ]);
    if (r.code === 0) return;
    await sleep(500);
  }

  // eslint-disable-next-line no-console
  console.error("[smoke] postgres did not become healthy in time. postgres logs:");
  await run("docker", ["compose", "-p", project, "-f", composeFile, "logs", "--no-color", "--tail", "200", "postgres"]).catch(() => {});
  throw new Error("postgres healthcheck timeout");
}

async function main() {
  const composeFile = "docker-compose.smoke.yml";
  const project = "eblusha-smoke";
  const keep = process.env.SMOKE_KEEP === "1";

  // Host-based tests: servers + test runner run on the host, so Redis must be reachable via localhost.
  // Use 127.0.0.1 to avoid IPv6 localhost (::1) issues with Docker port publishing.
  const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";
  const DATABASE_URL =
    process.env.DATABASE_URL || "postgresql://eblusha:eblusha@127.0.0.1:5433/eblusha_smoke";

  // eslint-disable-next-line no-console
  console.log(`[smoke] starting redis via docker compose (${composeFile})`);

  try {
    await run("docker", ["compose", "-p", project, "-f", composeFile, "up", "-d", "redis", "postgres"]);
  } catch (e: any) {
    // eslint-disable-next-line no-console
    console.error("[smoke] failed to start smoke services. Do you have docker + docker compose installed?");
    throw e;
  }

  try {
    // eslint-disable-next-line no-console
    console.log("[smoke] waiting for redis/postgres healthchecks...");
    await waitForRedisWithProject(composeFile, project);
    await waitForPostgresWithProject(composeFile, project);
    // eslint-disable-next-line no-console
    console.log("[smoke] redis and postgres are healthy");

    // eslint-disable-next-line no-console
    console.log("[smoke] applying prisma migrations (smoke db)...");
    await run("npx", ["prisma", "migrate", "deploy"], { env: { DATABASE_URL } });

    // eslint-disable-next-line no-console
    console.log("[smoke] running smoke tests...");
    await run("npm", ["run", "smoke:test"], { env: { REDIS_URL, DATABASE_URL } });
  } finally {
    if (keep) {
      // eslint-disable-next-line no-console
      console.log("[smoke] SMOKE_KEEP=1 set; leaving containers running");
      return;
    }
    // eslint-disable-next-line no-console
    console.log("[smoke] cleaning up smoke containers...");
    await run("docker", ["compose", "-p", project, "-f", composeFile, "down", "--remove-orphans"]).catch(() => {});
  }
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error("[smoke] failed:", e?.message || e);
  process.exit(1);
});

