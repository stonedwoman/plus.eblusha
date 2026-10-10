#!/usr/bin/env npx ts-node
/**
 * Учётка бота «Еблуша» (обычный User, без отдельного признака «бот» в схеме).
 *
 * Создаёт пользователя (или проверяет, что он есть), задаёт пароль и пишет логин/пароль и id
 * владельца в env-файл сервиса бота с правами 600. Пароль генерируется и НИКУДА не печатается.
 * Повторный запуск ничего не меняет, если пароль в файле уже есть (--rotate-password — сменить).
 * Имя, описание и аватар (фирменная «Б») бот ставит себе сам при старте (bot/src/main.ts).
 *
 * На сервере (из корня репозитория, боевая БД берётся из .env как у остальных скриптов):
 *   npx ts-node src/scripts/seedBotUser.ts --env-file /DATA/eblusha-plus/.env.bot-account \
 *     [--username eblusha_bot] [--owner-username <логин владельца>] [--rotate-password]
 * или в контейнере backend после пересборки: node dist/scripts/seedBotUser.js …
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";
import { hashPassword, verifyPassword } from "../utils/password";

export const BOT_DEFAULT_USERNAME = "eblusha_bot";
export const BOT_DISPLAY_NAME = "Еблуша";
export const BOT_BIO = "Бот. Позови: «Еблуша, …» или /eb. Продолжай ответом на моё сообщение.";

export interface EnsureBotUserResult {
  id: string;
  created: boolean;
  passwordChanged: boolean;
}

/** Создать или обновить пользователя бота. password — то, что должно стать (или уже является) паролем. */
export async function ensureBotUser(
  prisma: PrismaClient,
  opts: { username: string; password: string; forcePassword: boolean }
): Promise<EnsureBotUserResult> {
  const existing = await prisma.user.findUnique({
    where: { username: opts.username },
    select: { id: true, passwordHash: true, deletedAt: true, bannedAt: true },
  });
  if (!existing) {
    const u = await prisma.user.create({
      data: {
        username: opts.username,
        displayName: BOT_DISPLAY_NAME,
        bio: BOT_BIO,
        passwordHash: await hashPassword(opts.password),
      },
      select: { id: true },
    });
    return { id: u.id, created: true, passwordChanged: true };
  }
  if (existing.deletedAt || existing.bannedAt) {
    throw new Error(`пользователь ${opts.username} удалён или заблокирован — разберитесь вручную`);
  }
  const same = !opts.forcePassword && (await verifyPassword(opts.password, existing.passwordHash));
  if (!same) {
    await prisma.user.update({ where: { id: existing.id }, data: { passwordHash: await hashPassword(opts.password) } });
  }
  return { id: existing.id, created: false, passwordChanged: !same };
}

export function readEnvFile(file: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) out.set(m[1]!, m[2]!.replace(/^["']|["']$/g, ""));
  }
  return out;
}

/** Атомарная запись env-файла с правами 600: чужие строки сохраняются, наши ключи обновляются. */
export function writeEnvFile(file: string, values: Record<string, string>): void {
  const lines = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split(/\r?\n/) : [];
  const keys = new Set(Object.keys(values));
  const kept = lines.filter((l) => {
    const m = /^\s*([A-Z0-9_]+)\s*=/.exec(l);
    return !(m && keys.has(m[1]!));
  });
  while (kept.length && kept[kept.length - 1] === "") kept.pop();
  if (kept.length === 0) kept.push("# Учётка бота «Еблуша» — пишет src/scripts/seedBotUser.ts. Права 600, в git не класть.");
  for (const [k, v] of Object.entries(values)) kept.push(`${k}=${v}`);
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, kept.join("\n") + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith("--") ? process.argv[i + 1]! : null;
}

async function main(): Promise<void> {
  const envFile = arg("--env-file");
  if (!envFile) throw new Error("нужен --env-file /путь/к/.env.bot-account");
  const prisma = (await import("../lib/prisma")).default;
  try {
    const current = readEnvFile(envFile);
    const username = arg("--username") ?? current.get("BOT_USERNAME") ?? BOT_DEFAULT_USERNAME;
    const rotate = process.argv.includes("--rotate-password");
    const password = !rotate && current.get("BOT_PASSWORD") ? current.get("BOT_PASSWORD")! : crypto.randomBytes(24).toString("base64url");
    const r = await ensureBotUser(prisma, { username, password, forcePassword: rotate });

    const values: Record<string, string> = { BOT_USERNAME: username, BOT_PASSWORD: password, BOT_USER_ID: r.id };
    const ownerName = arg("--owner-username");
    if (ownerName) {
      const owner = await prisma.user.findUnique({ where: { username: ownerName }, select: { id: true } });
      if (!owner) throw new Error(`владелец ${ownerName} не найден`);
      values.BOT_OWNER_USER_ID = owner.id;
    }
    writeEnvFile(envFile, values);
    console.log(
      `[seedBotUser] пользователь бота id=${r.id} ${r.created ? "создан" : "уже был"}${r.passwordChanged ? ", пароль задан" : ", пароль не менялся"}; ` +
        `записано в ${envFile}: ${Object.keys(values).join(", ")} (значения не печатаются)`
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((e: unknown) => {
    console.error(`[seedBotUser] ошибка: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
