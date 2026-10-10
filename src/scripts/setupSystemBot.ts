#!/usr/bin/env npx ts-node
/**
 * Перевести уже заведённого бота «Еблуша» в «часть системы» (src/lib/systemBot.ts). Идемпотентно.
 *
 * Было (выкладка 2026-10-10): бот — обычный пользователь: контакты, личка с каждым добавившим, мог
 * сидеть в группах. Стало: бот не участник бесед, отвечает в любой обычной беседе по обращению;
 * личный «Чат с Еблушей» — настройка пользователя (по умолчанию выключена).
 *
 * Что делает (без --apply — только считает и печатает, ничего не меняет):
 *   1. User.isBot = true у бота;
 *   2. Message.isBot = true у всех его облачных сообщений (клиенты рисуют «бот» по этому полю);
 *   3. контакты с ботом — удаляются (бот в контактах не бывает);
 *   4. группы — бот из них выходит БЕЗ системной записи (он и так отвечает там по обращению);
 *   5. облачные 1:1 человек↔бот — становятся его «Чатом с Еблушей» (createdById = человек): человек
 *      его сам когда-то завёл, значит настройка для него «включена»; лишние дубли 1:1 — бот выходит;
 *   6. секретные треды с ботом не трогаем (отклонены, облачных сообщений в них нет).
 * Печатает только счётчики (без текстов и имён). Пользователям ничего не рассылает: списки бесед
 * обновятся при следующей загрузке.
 *
 *   TS_NODE_TRANSPILE_ONLY=1 node -r ts-node/register src/scripts/setupSystemBot.ts \
 *     [--account-file /DATA/eblusha-plus/.env.bot-account | --username eblusha_bot] [--apply]
 * или в контейнере backend: node dist/scripts/setupSystemBot.js … (после выкладки миграции system_bot).
 */
import type { PrismaClient } from "@prisma/client";
import { BOT_DEFAULT_USERNAME, readEnvFile } from "./seedBotUser";

export interface SetupReport {
  botId: string;
  markedBot: boolean;
  botMessagesMarked: number;
  contactsRemoved: number;
  groupsLeft: number;
  botChats: number;
  duplicateChatsLeft: number;
}

export async function setupSystemBot(prisma: PrismaClient, username: string, apply: boolean): Promise<SetupReport> {
  const bot = await prisma.user.findUnique({
    where: { username },
    select: { id: true, isBot: true, deletedAt: true, bannedAt: true },
  });
  if (!bot) throw new Error(`пользователь ${username} не найден (сначала src/scripts/seedBotUser.ts)`);
  if (bot.deletedAt || bot.bannedAt) throw new Error(`пользователь ${username} удалён или заблокирован`);
  const botId = bot.id;

  const contacts = await prisma.contact.findMany({
    where: { OR: [{ requesterId: botId }, { addresseeId: botId }] },
    select: { id: true },
  });
  const memberships = await prisma.conversationParticipant.findMany({
    where: { userId: botId },
    select: {
      conversationId: true,
      conversation: {
        select: { id: true, isGroup: true, type: true, isSecret: true, createdAt: true, participants: { select: { userId: true } } },
      },
    },
  });
  const groups = memberships.filter((m) => m.conversation.isGroup && m.conversation.type !== "SECRET");
  const pairs = memberships
    .map((m) => m.conversation)
    .filter((c) => !c.isGroup && c.type !== "SECRET" && !c.isSecret)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  // 1:1 человек↔бот: первая беседа на человека — его чат с ботом, остальные (и странные) — бот выходит.
  const chatByHuman = new Map<string, string>();
  const leave: string[] = groups.map((g) => g.conversationId);
  for (const c of pairs) {
    const humans = c.participants.map((p) => p.userId).filter((id) => id !== botId);
    if (humans.length !== 1 || chatByHuman.has(humans[0]!)) {
      leave.push(c.id);
      continue;
    }
    chatByHuman.set(humans[0]!, c.id);
  }
  const unmarked = await prisma.message.count({ where: { senderId: botId, isBot: false } });

  if (apply) {
    await prisma.$transaction(async (tx) => {
      if (!bot.isBot) await tx.user.update({ where: { id: botId }, data: { isBot: true } });
      await tx.message.updateMany({ where: { senderId: botId, isBot: false }, data: { isBot: true } });
      if (contacts.length) await tx.contact.deleteMany({ where: { id: { in: contacts.map((c) => c.id) } } });
      if (leave.length) await tx.conversationParticipant.deleteMany({ where: { userId: botId, conversationId: { in: leave } } });
      for (const [human, conversationId] of chatByHuman) {
        await tx.conversation.update({ where: { id: conversationId }, data: { createdById: human } });
      }
    });
  }

  return {
    botId,
    markedBot: !bot.isBot,
    botMessagesMarked: unmarked,
    contactsRemoved: contacts.length,
    groupsLeft: groups.length,
    botChats: chatByHuman.size,
    duplicateChatsLeft: leave.length - groups.length,
  };
}

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith("--") ? process.argv[i + 1]! : null;
}

async function main(): Promise<void> {
  const accountFile = arg("--account-file");
  const username = arg("--username") ?? (accountFile ? readEnvFile(accountFile).get("BOT_USERNAME") : null) ?? BOT_DEFAULT_USERNAME;
  const apply = process.argv.includes("--apply");
  const prisma = (await import("../lib/prisma")).default;
  try {
    const r = await setupSystemBot(prisma, username, apply);
    console.log(`[setupSystemBot] ${apply ? "ПРИМЕНЕНО" : "проверка (без --apply ничего не менялось)"}: ${JSON.stringify(r)}`);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((e: unknown) => {
    console.error(`[setupSystemBot] ошибка: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
