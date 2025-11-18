import axios from "axios";
import { io } from "socket.io-client";

async function main() {
  const api = axios.create({ baseURL: "http://localhost:4000/api" });

  const username = `user_${Date.now()}`;
  const password = "Password123!";
  const displayName = "Smoke Tester";

  try {
    await api.post("/auth/register", { username, password, displayName });
    console.log("register: ok");
  } catch (e: any) {
    if (e?.response?.status === 409) {
      console.log("register: already exists (ok)");
    } else {
      console.error("register: fail", e?.response?.data || e?.message);
      process.exit(1);
    }
  }

  const loginResp = await api.post("/auth/login", { username, password });
  const { accessToken, refreshToken, user } = loginResp.data;
  console.log("login: ok", user);

  const meResp = await api.get("/status/me", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  console.log("status/me:", meResp.data.user);

  await new Promise<void>((resolve) => {
    const socket = io("http://localhost:4000", {
      transports: ["websocket"],
      auth: { token: accessToken },
      query: { token: accessToken },
    });
    const timer = setTimeout(() => {
      console.warn("socket: timeout");
      socket.close();
      resolve();
    }, 4000);
    socket.on("connect", () => {
      console.log("socket: connected", socket.id);
      clearTimeout(timer);
      socket.close();
      resolve();
    });
    socket.on("connect_error", (err) => {
      console.error("socket: error", err.message);
    });
    socket.on("disconnect", (reason) => {
      console.log("socket: disconnected", reason);
    });
  });
}

main().catch((e) => {
  console.error("smoke: fail", e?.response?.data || e);
  process.exit(1);
});


