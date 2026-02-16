import http from "node:http";
import { initSocket } from "../../src/realtime/socket";

async function main() {
  const server = http.createServer((_req, res) => {
    res.statusCode = 200;
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.end("ok");
  });

  await initSocket(server);

  const desiredPort = process.env.PORT ? Number(process.env.PORT) : 0;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(desiredPort, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to start presence instance server");
  }

  // Parent process parses this line.
  // eslint-disable-next-line no-console
  console.log(`PRESENCE_INSTANCE_READY ${address.port}`);

  const shutdown = async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

void main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("presence-instance: failed", err);
  process.exit(1);
});

