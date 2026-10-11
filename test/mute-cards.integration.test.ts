/**
 * «Без звука» × карточки бота (слияние feat/chat-mute + feat/promise-timer-srv, выпуск 2026-10-11):
 * напоминание таймера будит обещавшего в заглушённой ГРУППЕ, даже когда оно отвечает на карточку (а не на его
 * сообщение) — через metadata.bot.mentions → publishNewMessage({mentions}) → loadAlertGate(mentionedUserIds);
 * обычное сообщение бота в той же беседе его не будит; карточка «поделиться» с pushTo — только спросившему.
 * Только в изолированной среде: test/secret-env/secret-test.sh run test/mute-cards.integration.test.ts
 * В конце — строка EB_PROOF для `secret-test.sh prod-proof`.
 */
import { assertIsolatedBackends } from "./secret-env/guard";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import prisma from "../src/lib/prisma";
import { getRedisClient } from "../src/lib/redis";
import { getPushQueue } from "../src/jobs/queue";
import { createBotMessage, resetSystemBotCache } from "../src/lib/systemBot";
import { createPromiseTimer, processPromiseReminder } from "../src/lib/promiseTimer";
import { setConversationMute } from "../src/lib/conversationMute";
import { ensureBotUser } from "../src/scripts/seedBotUser";

const RUN = `ebst_mc_${Date.now().toString(36)}_${crypto.randomBytes(3).toString("hex")}`;

async function pushOf(messageId: string): Promise<string[] | null> {
  for (let i = 0; i < 50; i++) {
    const job = await getPushQueue().getJob(`msg-${messageId}`);
    if (job) return [...(job.data as { userIds: string[] }).userIds].sort();
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

async function main() {
  const redis = await getRedisClient();
  await assertIsolatedBackends(prisma, redis);
  await prisma.user.updateMany({ where: { isBot: true }, data: { isBot: false } });
  const bot = await ensureBotUser(prisma, { username: `${RUN}_bot`, password: crypto.randomBytes(18).toString("base64url"), forcePassword: false });
  resetSystemBotCache();
  const mk = (s: string, n: string) => prisma.user.create({ data: { username: `${RUN}_${s}`, displayName: n, passwordHash: `x_${crypto.randomUUID()}` } });
  const R = await mk("roma", "Рома");
  const V = await mk("vasya", "Вася");
  const P = await mk("petya", "Петя");
  const g = await prisma.conversation.create({
    data: { isGroup: true, title: `${RUN} группа`, createdById: R.id, participants: { create: [R, V, P].map((u) => ({ userId: u.id })) } },
  });
  assert.ok(await setConversationMute(V.id, g.id, new Date(Date.now() + 8 * 3600_000)), "Вася заглушил группу");
  const ask = await prisma.message.create({ data: { conversationId: g.id, senderId: R.id, type: "TEXT", content: "Еблуша, проследи, чтобы Вася был через 1 минуту" } });
  const t = await createPromiseTimer({
    conversationId: g.id,
    triggerMessageId: ask.id,
    requesterId: R.id,
    promiserId: V.id,
    text: "через 1 минуту",
    cancelAllowedIds: [R.id],
  });
  assert.ok(t.ok && !t.dryRun, JSON.stringify(t));
  const row = (t as { row: { id: string; deadlineAt: Date; cardMessageId: string } }).row;
  assert.equal(await processPromiseReminder(row.id, row.deadlineAt.getTime(), 0), "sent");
  const rem = await prisma.message.findFirstOrThrow({ where: { conversationId: g.id, isBot: true, metadata: { path: ["bot", "promiseId"], equals: row.id } } });
  assert.equal(rem.replyToId, row.cardMessageId, "напоминание — ответом на карточку (слов Васи нет)");
  const remPush = await pushOf(rem.id);
  assert.ok(remPush && remPush.includes(V.id), `заглушившему группу обещавшему — пуш (упоминание): ${JSON.stringify(remPush)}`);
  // обычное сообщение бота — Васю (заглушил) не будит
  const plain = await createBotMessage({ botId: bot.id, conversationId: g.id, type: "TEXT", content: "просто ответ", kind: "answer" });
  const plainPush = await pushOf(plain.id);
  assert.ok(plainPush && !plainPush.includes(V.id) && plainPush.includes(P.id), `обычное — без Васи: ${JSON.stringify(plainPush)}`);
  // pushTo (карточка «поделиться») — только спросившему, даже если остальные не глушили
  const card = await createBotMessage({ botId: bot.id, conversationId: g.id, type: "TEXT", content: "🔒 карточка", kind: "notice", pushTo: [R.id] });
  const cardPush = await pushOf(card.id);
  assert.deepEqual(cardPush, [R.id], "pushTo — только спросившему");
  const proofKey = `eb-mute-cards:${RUN}`;
  await redis.set(proofKey, "1", { EX: 3600 });
  const proof = { run: RUN, userIds: [bot.id, R.id, V.id, P.id], usernames: [`${RUN}_bot`, `${RUN}_roma`, `${RUN}_vasya`, `${RUN}_petya`], deviceIds: [`${RUN}-nodevice`], threadId: g.id, msgId: crypto.randomUUID(), redisKeys: [proofKey] };
  console.log(`EB_PROOF ${JSON.stringify(proof)}`);
  console.log("mute × cards: ok");
  await prisma.user.update({ where: { id: bot.id }, data: { isBot: false, deletedAt: new Date() } }).catch(() => undefined);
}

main().then(
  async () => {
    await prisma.$disconnect().catch(() => undefined);
    process.exit(0);
  },
  async (e) => {
    console.error("mute × cards: FAILED", e);
    await prisma.$disconnect().catch(() => undefined);
    process.exit(1);
  }
);
