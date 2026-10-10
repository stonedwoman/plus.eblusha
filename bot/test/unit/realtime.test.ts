/**
 * Сокет Еблуши: после ОТКАЗА сервера (middleware «Unauthorized», «io server disconnect»)
 * socket.io-клиент сам не переподключается — Realtime делает это вручную, с паузой.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Realtime, type RealtimeHandlers, type SocketLike } from "../../src/api/realtime";
import { silentLogger } from "../../src/log";

class FakeSocket {
  connected = false;
  active = true;
  connects = 0;
  handlers = new Map<string, (...a: unknown[]) => void>();
  on(ev: string, fn: (...a: unknown[]) => void) {
    this.handlers.set(ev, fn);
    return this;
  }
  emit() {
    return this;
  }
  connect() {
    this.connects++;
    this.active = true;
    return this;
  }
  disconnect() {
    this.active = false;
    this.connected = false;
    return this;
  }
  fire(ev: string, ...a: unknown[]) {
    this.handlers.get(ev)?.(...a);
  }
}

const handlers = (): RealtimeHandlers & { connects: number; disconnects: number } => {
  const h = {
    connects: 0,
    disconnects: 0,
    onMessage() {},
    onConversationsChanged() {},
    onSecretThread() {},
    onContactRequest() {},
    onIncomingCall() {},
    onConnect() {
      h.connects++;
    },
    onDisconnect() {
      h.disconnects++;
    },
  };
  return h;
};

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("отказ в рукопожатии (socket.active=false) → ручное переподключение с паузой", async () => {
  const fake = new FakeSocket();
  const rt = new Realtime("http://x", async () => "t", handlers(), silentLogger, {
    connect: () => fake as unknown as SocketLike,
    manualRetryMs: 20,
  });
  rt.start();
  // временная ошибка сети: клиент переподключится сам — мы не вмешиваемся
  fake.fire("connect_error", new Error("xhr poll error"));
  await wait(40);
  assert.equal(fake.connects, 0);
  // отказ middleware: клиент сдался
  fake.active = false;
  fake.fire("connect_error", new Error("Unauthorized"));
  fake.fire("connect_error", new Error("Unauthorized")); // повтор не ставит второй таймер
  await wait(40);
  assert.equal(fake.connects, 1);
  // следующая пауза — вдвое длиннее
  fake.active = false;
  fake.fire("connect_error", new Error("Unauthorized"));
  await wait(25);
  assert.equal(fake.connects, 1);
  await wait(40);
  assert.equal(fake.connects, 2);
  rt.stop();
});

test("«io server disconnect» → переподключаемся; свой stop() — нет", async () => {
  const fake = new FakeSocket();
  const h = handlers();
  const rt = new Realtime("http://x", async () => "t", h, silentLogger, { connect: () => fake as unknown as SocketLike, manualRetryMs: 10 });
  rt.start();
  fake.connected = true;
  fake.fire("connect");
  assert.equal(h.connects, 1);
  fake.connected = false;
  fake.active = false;
  fake.fire("disconnect", "io server disconnect");
  assert.equal(h.disconnects, 1);
  await wait(30);
  assert.equal(fake.connects, 1);

  // обрыв транспорта: socket.active=true — клиент сам, мы не трогаем
  fake.fire("disconnect", "transport close");
  await wait(30);
  assert.equal(fake.connects, 1);

  // остановка: таймер снят, connect() больше не зовётся
  fake.active = false;
  fake.fire("connect_error", new Error("Unauthorized"));
  rt.stop();
  await wait(60);
  assert.equal(fake.connects, 1);
});
