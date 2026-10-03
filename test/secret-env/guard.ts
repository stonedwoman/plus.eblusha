/**
 * Предохранитель тестовой среды eb-secret-test.
 *
 * Подключается раньше приложения: `ts-node -r ./test/secret-env/guard.ts <тест>`
 * (так запускает test/secret-env/secret-test.sh run). Роняет процесс с кодом 97,
 * если хоть что-то указывает на боевые БД/Redis/дерево кода:
 *   - DATABASE_URL/REDIS_URL не на тестовых 127.0.0.1:55433/56380 или не та БД;
 *   - процесс запущен из боевого дерева /DATA/eblusha-plus (там лежит боевой .env,
 *     его подхватили бы и dotenv из src/config/env.ts, и сам Prisma-клиент);
 *   - .env, который прочтут dotenv (cwd) и Prisma (рядом со сгенерированным клиентом),
 *     не помечен EB_SECRET_TEST=1, или рядом лежит .env.local (он перекрывает всё);
 *   - любой модуль резолвится из боевого дерева или кто-то читает боевой .env*.
 *
 * Вторая половина — assertIsolatedBackends(prisma, redis): спрашивает у ТЕХ ЖЕ клиентов,
 * что использует приложение, к кому они на самом деле подключены (имя БД, cluster_name,
 * комментарий к БД, ключ-метка в Redis). Вызывать в начале каждого интеграционного теста.
 *
 * Сам модуль НИЧЕГО не импортирует из src/ (иначе src/config/env.ts успел бы прочесть .env).
 */
import fs from "node:fs";
import path from "node:path";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Module = require("node:module") as {
  _resolveFilename: (request: string, parent: unknown, isMain: boolean, options?: unknown) => string;
};

export const PROD_REPO = "/DATA/eblusha-plus";
export const EXPECTED = {
  pgHost: "127.0.0.1",
  pgPort: process.env.EB_TEST_PG_PORT || "55433",
  pgDb: "eblusha_secret_test",
  pgUser: "ebtest",
  pgCluster: "eb-secret-test",
  redisHost: "127.0.0.1",
  redisPort: process.env.EB_TEST_REDIS_PORT || "56380",
  marker: "eb-secret-test",
  markerKey: "eb-secret-test:marker",
} as const;

function die(msg: string): never {
  // stderr + немедленный выход: тест не должен успеть открыть ни одного соединения.
  process.stderr.write(`\n[eb-secret-test guard] ОТКАЗ: ${msg}\n\n`);
  process.exit(97);
}

function underProdRepo(p: string): boolean {
  return p === PROD_REPO || p.startsWith(PROD_REPO + "/");
}

function realpathOr(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** URL без логина/пароля — для логов. */
export function describeUrl(raw: string | undefined): string {
  if (!raw) return "<unset>";
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.hostname}:${u.port}${u.pathname}`;
  } catch {
    return "<invalid url>";
  }
}

function envFileIsTest(file: string): boolean {
  try {
    return /^EB_SECRET_TEST=1\s*$/m.test(fs.readFileSync(file, "utf8"));
  } catch {
    return false;
  }
}

/** Где Prisma-клиент сам ищет .env (relativeEnvPaths.schemaEnvPath = ../../../.env от .prisma/client). */
export function prismaEnvPath(): string {
  const idx = require.resolve(".prisma/client/index.js", { paths: [process.cwd()] });
  return path.resolve(path.dirname(idx), "../../../.env");
}

export function checkEnvSync(): void {
  if (process.env.EB_SECRET_TEST !== "1") die("EB_SECRET_TEST!=1 — запускать только через test/secret-env/secret-test.sh run");
  if (process.env.NODE_ENV === "production") die("NODE_ENV=production");

  let db: URL;
  let rd: URL;
  try {
    db = new URL(process.env.DATABASE_URL ?? "");
  } catch {
    die("DATABASE_URL не задан или не URL");
  }
  try {
    rd = new URL(process.env.REDIS_URL ?? "");
  } catch {
    die("REDIS_URL не задан или не URL");
  }
  if (
    db.hostname !== EXPECTED.pgHost ||
    db.port !== EXPECTED.pgPort ||
    db.pathname !== `/${EXPECTED.pgDb}` ||
    db.username !== EXPECTED.pgUser
  ) {
    die(
      `DATABASE_URL=${describeUrl(db.href)} (user=${db.username}) — ждём ${EXPECTED.pgUser}@${EXPECTED.pgHost}:${EXPECTED.pgPort}/${EXPECTED.pgDb}`
    );
  }
  if (rd.hostname !== EXPECTED.redisHost || rd.port !== EXPECTED.redisPort) {
    die(`REDIS_URL=${describeUrl(rd.href)} — ждём redis://${EXPECTED.redisHost}:${EXPECTED.redisPort}`);
  }

  const cwd = realpathOr(process.cwd());
  if (underProdRepo(cwd)) die(`cwd=${cwd} — это боевое дерево, там боевой .env`);

  const dotenvFile = path.join(cwd, ".env");
  if (fs.existsSync(dotenvFile) && !envFileIsTest(dotenvFile)) die(`${dotenvFile} не помечен EB_SECRET_TEST=1`);
  const dotenvLocal = path.join(cwd, ".env.local");
  if (fs.existsSync(dotenvLocal)) die(`${dotenvLocal} существует — он перекрыл бы тестовые значения`);

  let prismaEnv: string;
  try {
    prismaEnv = realpathOr(prismaEnvPath());
  } catch {
    die("не найден сгенерированный .prisma/client (secret-test.sh sync делает prisma generate)");
  }
  if (underProdRepo(prismaEnv)) die(`Prisma-клиент из боевого дерева: прочтёт ${prismaEnv}`);
  if (fs.existsSync(prismaEnv) && !envFileIsTest(prismaEnv)) {
    die(`${prismaEnv} (его грузит Prisma-клиент) не помечен EB_SECRET_TEST=1`);
  }
}

function installTripwires(): void {
  // 1) Ни один модуль не должен прийти из боевого дерева (src, node_modules, сгенерированный клиент).
  const origResolve = Module._resolveFilename;
  Module._resolveFilename = function (this: unknown, request, parent, isMain, options) {
    const resolved = origResolve.call(this, request, parent, isMain, options);
    if (typeof resolved === "string" && path.isAbsolute(resolved) && underProdRepo(resolved)) {
      const from = (parent as { filename?: string } | null)?.filename ?? "?";
      die(`модуль резолвится из боевого дерева: ${resolved} (require из ${from})`);
    }
    return resolved;
  };
  // 2) Никто (dotenv, Prisma) не читает боевые .env*.
  const origRead = fs.readFileSync as (...a: unknown[]) => unknown;
  (fs as unknown as { readFileSync: unknown }).readFileSync = function (file: unknown, ...rest: unknown[]) {
    if (typeof file === "string" || file instanceof URL) {
      const p = path.resolve(file instanceof URL ? file.pathname : file);
      if (underProdRepo(p) && /^\.env/.test(path.basename(p))) die(`попытка прочитать боевой ${p}`);
    }
    return origRead.call(fs, file, ...rest);
  };
}

type QueryRaw = { $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T> };
type RedisLike = { get(key: string): Promise<string | null>; info(section?: string): Promise<string> };

export type BackendIdentity = {
  database: string;
  dbUser: string;
  cluster: string;
  dbComment: string | null;
  serverVersion: string;
  redisMarker: string | null;
  redisRunId: string | null;
};

/**
 * Спрашивает у живых клиентов приложения, куда они подключены, и роняет тест, если не в тестовую среду.
 * prisma — ровно тот экземпляр, что импортирует приложение (src/lib/prisma), redis — getRedisClient().
 */
export async function assertIsolatedBackends(prisma: QueryRaw, redis: RedisLike): Promise<BackendIdentity> {
  const rows = await prisma.$queryRawUnsafe<
    Array<{ database: string; db_user: string; cluster: string; db_comment: string | null; server_version: string }>
  >(
    `SELECT current_database() AS database, current_user AS db_user,
            current_setting('cluster_name') AS cluster,
            shobj_description(d.oid, 'pg_database') AS db_comment,
            current_setting('server_version') AS server_version
       FROM pg_database d WHERE d.datname = current_database()`
  );
  const r = rows[0];
  if (!r) die("пустой ответ на запрос идентичности БД");
  const info = await redis.info("server");
  const runId = /^run_id:(.*)$/m.exec(info)?.[1]?.trim() ?? null;
  const id: BackendIdentity = {
    database: r.database,
    dbUser: r.db_user,
    cluster: r.cluster,
    dbComment: r.db_comment,
    serverVersion: r.server_version,
    redisMarker: await redis.get(EXPECTED.markerKey),
    redisRunId: runId,
  };
  if (
    id.database !== EXPECTED.pgDb ||
    id.cluster !== EXPECTED.pgCluster ||
    id.dbComment !== EXPECTED.marker ||
    id.dbUser !== EXPECTED.pgUser
  ) {
    die(`приложение подключено НЕ к тестовой БД: ${JSON.stringify(id)}`);
  }
  if (id.redisMarker !== EXPECTED.marker) {
    die(`приложение подключено НЕ к тестовому Redis (нет метки ${EXPECTED.markerKey}): ${JSON.stringify(id)}`);
  }
  return id;
}

// Срабатывает при первом импорте (через -r — до загрузки приложения).
checkEnvSync();
installTripwires();
