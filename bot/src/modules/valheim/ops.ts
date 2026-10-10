/**
 * Клиент помощника valheim-ops (bot/ops/valheim-ops.py): хостовый сервис на stoned от root,
 * слушает unix-сокет и выполняет ТОЛЬКО действия из белого списка — статус, рестарт «когда
 * опустеет» / «сейчас» / отмена, бэкап мира, чтение и правка настроек мира. Бот не получает
 * ни docker.sock, ни токен правки настроек: всё это знает только помощник.
 *
 * Вызывают его исключительно команды владельца (commands.ts) после «да». У модели доступа нет.
 */
import http from "node:http";

export type OpsAction = "status" | "restart_when_empty" | "restart_now" | "restart_cancel" | "backup_now" | "options_set";

export interface OpsResult {
  ok: boolean;
  error?: string;
  [k: string]: unknown;
}

export interface OpsStatus extends OpsResult {
  container?: { running: boolean; status?: string; startedAt?: string | null; health?: string | null };
  restartWhenEmpty?: { active: boolean; since?: string | null };
  restartNow?: { active: boolean };
  backups?: { hourlyCount?: number; lastHourly?: { file: string; at: string; size: number } | null; lastManual?: { path: string; at: string; size: number } | null };
  disk?: { freeGb: number; totalGb: number };
  game?: { version?: string | null; plugins?: number | null };
  error?: string;
}


export class OpsUnavailable extends Error {}

export interface OpsClientLike {
  call<T extends OpsResult = OpsResult>(action: OpsAction, args?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
}

export class OpsClient implements OpsClientLike {
  constructor(readonly socketPath: string | null) {}

  call<T extends OpsResult = OpsResult>(action: OpsAction, args: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
    const socketPath = this.socketPath;
    if (!socketPath) return Promise.reject(new OpsUnavailable("помощник valheim-ops не настроен (VALHEIM_OPS_SOCKET пуст)"));
    const body = JSON.stringify(args);
    return new Promise<T>((resolve, reject) => {
      const req = http.request(
        {
          socketPath,
          path: `/v1/${action}`,
          method: "POST",
          headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
          timeout: timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            try {
              const v = JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
              resolve(v);
            } catch {
              reject(new Error(`valheim-ops: непонятный ответ (${res.statusCode})`));
            }
          });
        }
      );
      req.on("timeout", () => req.destroy(new Error("valheim-ops: нет ответа")));
      req.on("error", (e: NodeJS.ErrnoException) => {
        if (e.code === "ENOENT" || e.code === "ECONNREFUSED" || e.code === "EACCES") reject(new OpsUnavailable(`помощник valheim-ops не запущен или недоступен (${e.code})`));
        else reject(e);
      });
      req.end(body);
    });
  }
}
