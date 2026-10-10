import { test } from "node:test";
import assert from "node:assert/strict";
import { downloadImage, ImageFetchError, isPrivateAddress, sniffImage } from "../../src/core/images";
import { apiSchema, hasAccess, validateInput } from "../../src/core/registry";
import type { JsonSchemaObject, Requester } from "../../src/modules/api";

test("сигнатуры и размеры картинок", () => {
  const png = Buffer.alloc(32);
  png.writeUInt32BE(0x89504e47, 0);
  png.write("IHDR", 12, "ascii");
  png.writeUInt32BE(640, 16);
  png.writeUInt32BE(480, 20);
  assert.deepEqual(sniffImage(png), { mime: "image/png", width: 640, height: 480 });

  const gif = Buffer.from("GIF89a\x20\x03\x58\x02", "latin1");
  assert.deepEqual(sniffImage(gif), { mime: "image/gif", width: 800, height: 600 });

  // JPEG: SOI, APP0 (len 16), SOF0 с высотой 300 и шириной 400
  const jpeg = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
    Buffer.alloc(14),
    Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x2c, 0x01, 0x90, 0x03]),
    Buffer.alloc(16),
  ]);
  assert.deepEqual(sniffImage(jpeg), { mime: "image/jpeg", width: 400, height: 300 });

  const webp = Buffer.alloc(32);
  webp.write("RIFF", 0, "ascii");
  webp.write("WEBP", 8, "ascii");
  webp.write("VP8X", 12, "ascii");
  webp.writeUIntLE(1023, 24, 3);
  webp.writeUIntLE(767, 27, 3);
  assert.deepEqual(sniffImage(webp), { mime: "image/webp", width: 1024, height: 768 });

  assert.equal(sniffImage(Buffer.from("<svg xmlns=...>")), null);
});

test("внутренние адреса запрещены", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.1.129", "172.20.0.5", "169.254.1.1", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "224.0.0.1"]) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ["8.8.8.8", "151.101.1.1", "2606:4700::1111"]) assert.equal(isPrivateAddress(ip), false, ip);
});

test("downloadImage: только https и не во внутреннюю сеть (без сетевых походов)", async () => {
  await assert.rejects(downloadImage("http://example.com/a.png"), (e: unknown) => e instanceof ImageFetchError && /https/.test(e.message));
  await assert.rejects(downloadImage("https://127.0.0.1:4000/api/x.png"), (e: unknown) => e instanceof ImageFetchError && /внутренний/.test(e.message));
  await assert.rejects(downloadImage("https://[::1]/x.png"), (e: unknown) => e instanceof ImageFetchError && /внутренний/.test(e.message));
  // localhost резолвится в 127.0.0.1 — режется в lookup соединения
  await assert.rejects(downloadImage("https://localhost:3010/map"), (e: unknown) => e instanceof ImageFetchError && /внутренний/.test(e.message));
  await assert.rejects(downloadImage("https://user:pass@example.com/a.png"), (e: unknown) => e instanceof ImageFetchError);
});

test("проверка входа инструмента и схема для strict", () => {
  const s: JsonSchemaObject = {
    type: "object",
    properties: {
      name: { type: "string" },
      radius: { type: "integer", minimum: 100, maximum: 3000 },
      layers: { type: "array", items: { type: "string", enum: ["players", "portals"] } },
      fog: { type: "boolean" },
    },
    required: ["name"],
    additionalProperties: false,
  };
  assert.equal(validateInput({ name: "X" }, s), null);
  assert.equal(validateInput({ name: "X", radius: 400, layers: ["players"], fog: false }, s), null);
  assert.match(validateInput({}, s)!, /нет поля name/);
  assert.match(validateInput({ name: "X", radius: 50 }, s)!, /не меньше 100/);
  assert.match(validateInput({ name: "X", radius: 4.5 }, s)!, /целое/);
  assert.match(validateInput({ name: "X", layers: ["boom"] }, s)!, /одно из/);
  assert.match(validateInput({ name: "X", evil: 1 }, s)!, /лишнее поле/);
  assert.match(validateInput("строка", s)!, /объектом/);
  const api = JSON.stringify(apiSchema(s));
  assert.ok(!api.includes("minimum") && !api.includes("maximum"), api);
  assert.ok(api.includes('"additionalProperties":false'));
});

test("доступ: anyone / player / owner (только в личке)", () => {
  const r = (o: Partial<Requester>): Requester => ({ userId: "u", displayName: "u", isOwner: false, characters: [], isPlayer: false, ...o });
  assert.equal(hasAccess("anyone", r({}), false), true);
  assert.equal(hasAccess("player", r({}), true), false);
  assert.equal(hasAccess("player", r({ isPlayer: true, characters: ["X"] }), false), true);
  assert.equal(hasAccess("owner", r({ isOwner: true, isPlayer: true }), false), false);
  assert.equal(hasAccess("owner", r({ isOwner: true, isPlayer: true }), true), true);
});
