import { Inject, Injectable } from "@nestjs/common";
import { AppConfig, CONFIG } from "./config";
import type { SessionInfo } from "./types";

export class StalwartError extends Error {
  constructor(public readonly kind: "auth" | "unavailable" | "protocol", message: string) {
    super(message);
  }
}

// Белый список JMAP-методов: сервер НЕ является открытым прокси к Stalwart.
// Настройки аккаунта, ключи и пароли приложений через него недоступны.
const ALLOWED_METHODS = new Set(["Mailbox/get"]);
const USING = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"];
const MAIL_CAP = "urn:ietf:params:jmap:mail";

@Injectable()
export class StalwartClient {
  constructor(@Inject(CONFIG) private readonly cfg: AppConfig) {}

  private async request(path: string, email: string, password: string, init: RequestInit = {}): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: "Basic " + Buffer.from(`${email}:${password}`).toString("base64"),
      ...((init.headers as Record<string, string>) ?? {}),
    };
    try {
      // redirect: "manual": никуда сами не переходим; адрес всегда наш внутренний
      return await fetch(this.cfg.stalwartUrl + path, {
        ...init, headers, redirect: "manual", signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new StalwartError("unavailable", "почтовый сервер недоступен");
    }
  }

  /** Проверяет пароль приложения: успех даёт идентификатор аккаунта */
  async login(email: string, password: string): Promise<{ accountId: string }> {
    const r = await this.request("/jmap/session", email, password);
    if (r.status === 401 || r.status === 403) throw new StalwartError("auth", "неверный адрес или пароль");
    if (!r.ok) throw new StalwartError("unavailable", `ответ ${r.status}`);
    const j = (await r.json().catch(() => null)) as {
      primaryAccounts?: Record<string, string>;
      accounts?: Record<string, unknown>;
    } | null;
    const accountId = j?.primaryAccounts?.[MAIL_CAP] ?? Object.keys(j?.accounts ?? {})[0];
    if (typeof accountId !== "string" || !accountId) throw new StalwartError("protocol", "в ответе нет аккаунта");
    return { accountId };
  }

  /** Один вызов JMAP от имени пользователя (идентификатор аккаунта подставляем сами) */
  async call(s: SessionInfo, method: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!ALLOWED_METHODS.has(method)) throw new StalwartError("protocol", `метод не разрешён: ${method}`);
    const r = await this.request("/jmap/", s.email, s.password, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ using: USING, methodCalls: [[method, { ...args, accountId: s.accountId }, "0"]] }),
    });
    if (r.status === 401 || r.status === 403) throw new StalwartError("auth", "доступ отозван");
    if (!r.ok) throw new StalwartError("unavailable", `ответ ${r.status}`);
    const data = (await r.json().catch(() => null)) as { methodResponses?: unknown[][] } | null;
    const first = data?.methodResponses?.[0];
    if (!first || first[0] === "error" || typeof first[1] !== "object") {
      throw new StalwartError("protocol", "ошибка метода JMAP");
    }
    return first[1] as Record<string, unknown>;
  }
}
