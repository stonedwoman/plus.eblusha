import type { NextFunction, Request, Response } from "express";
import logger from "../config/logger";

/**
 * Типизированные ошибки API. Наружу уходит только {code, message} — никаких
 * stack trace, путей на диске и внутренних идентификаторов.
 */
export class CloudError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: Record<string, unknown> | undefined;

  constructor(status: number, code: string, message: string, detail?: Record<string, unknown>) {
    super(message);
    this.name = "CloudError";
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

export const unauthorized = (m = "Требуется вход через Еблушу") => new CloudError(401, "UNAUTHENTICATED", m);
export const forbidden = (m = "Недостаточно прав") => new CloudError(403, "FORBIDDEN", m);
export const notFound = (m = "Не найдено") => new CloudError(404, "NOT_FOUND", m);
export const conflict = (m = "Конфликт состояния") => new CloudError(409, "CONFLICT", m);
export const tooLarge = (m = "Файл слишком большой") => new CloudError(413, "TOO_LARGE", m);
export const invalid = (m = "Некорректный запрос", detail?: Record<string, unknown>) =>
  new CloudError(422, "INVALID", m, detail);
export const rateLimited = (m = "Слишком много запросов") => new CloudError(429, "RATE_LIMITED", m);
export const insufficientStorage = (m = "Недостаточно места в хранилище") =>
  new CloudError(507, "INSUFFICIENT_STORAGE", m);

export function cloudErrorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  const requestId = req.requestId;
  if (err instanceof CloudError) {
    if (err.status >= 500) {
      logger.error({ err, requestId, path: req.path }, "cloud request failed");
    } else if (err.status === 401 || err.status === 403) {
      logger.warn({ requestId, path: req.path, code: err.code, userId: (req as any).cloudUser?.id }, "cloud access denied");
    }
    if (!res.headersSent) {
      res.status(err.status).json({ code: err.code, message: err.message, requestId, ...(err.detail ?? {}) });
    }
    return;
  }
  logger.error({ err, requestId, path: req.path }, "cloud unhandled error");
  if (!res.headersSent) {
    res.status(500).json({ code: "INTERNAL", message: "Внутренняя ошибка", requestId });
  }
}

/** Обёртка async-хендлеров: без неё отклонённый промис уходит в никуда. */
export function ah<T extends Request>(
  fn: (req: T, res: Response, next: NextFunction) => Promise<unknown>
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    void Promise.resolve(fn(req as T, res, next)).catch(next);
  };
}
