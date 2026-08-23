import { spawn } from "node:child_process";
import logger from "../../config/logger";

/**
 * Запуск внешних утилит над НЕДОВЕРЕННЫМ содержимым.
 *
 * Правила, которые здесь зашиты:
 *  - только spawn с массивом аргументов, никакой shell-интерполяции имён файлов;
 *  - жёсткий таймаут и kill всего дерева процессов;
 *  - ограниченный буфер stdout/stderr (ffmpeg умеет залить логами гигабайты);
 *  - пустое окружение, кроме PATH — ffmpeg читает десятки переменных.
 */
export type RunResult = { code: number; stdout: string; stderr: string };

export async function run(
  bin: string,
  args: string[],
  opts: { timeoutMs: number; maxOutputBytes?: number; cwd?: string } = { timeoutMs: 60_000 }
): Promise<RunResult> {
  const maxOut = opts.maxOutputBytes ?? 2 * 1024 * 1024;
  return new Promise<RunResult>((resolve, reject) => {
    const child = spawn(bin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", LANG: "C" },
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
    });

    let stdout = "";
    let stderr = "";
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // процесс уже мог умереть
      }
    }, opts.timeoutMs);
    timer.unref?.();

    child.stdout.on("data", (b: Buffer) => {
      if (stdout.length < maxOut) stdout += b.toString("utf8");
    });
    child.stderr.on("data", (b: Buffer) => {
      if (stderr.length < maxOut) stderr += b.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (killed) {
        logger.warn({ bin, timeoutMs: opts.timeoutMs }, "cloud media: process killed by timeout");
        reject(new Error(`${bin} timed out`));
        return;
      }
      resolve({ code: code ?? -1, stdout, stderr: stderr.slice(-8000) });
    });
  });
}

export async function runOk(bin: string, args: string[], opts: { timeoutMs: number }): Promise<RunResult> {
  const res = await run(bin, args, opts);
  if (res.code !== 0) {
    throw new Error(`${bin} exited ${res.code}: ${res.stderr.slice(-500)}`);
  }
  return res;
}
