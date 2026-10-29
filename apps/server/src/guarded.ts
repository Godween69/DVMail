import { HttpException, NotFoundException, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";
import type { SessionStore } from "./session.store";
import { StalwartError } from "./stalwart.client";
import type { SessionInfo, SessionRequest } from "./types";

// Общая обработка ошибок Stalwart для всех маршрутов с почтой:
// отозванный доступ закрывает сессию (401), «не найдено» это 404, всё остальное 502 без подробностей.
export async function runGuarded<T>(store: SessionStore, req: Request, fn: (s: SessionInfo) => Promise<T>): Promise<T> {
  const r = req as SessionRequest;
  try {
    return await fn(r.dvSession);
  } catch (e) {
    if (e instanceof HttpException) throw e;
    if (e instanceof StalwartError && e.kind === "auth") {
      store.destroy(r.dvToken);
      throw new UnauthorizedException({ message: "Требуется вход" });
    }
    if (e instanceof StalwartError && e.kind === "notfound") throw new NotFoundException({ message: "Письмо не найдено" });
    throw new HttpException({ message: "Почтовый сервер недоступен, попробуйте позже" }, 502);
  }
}
