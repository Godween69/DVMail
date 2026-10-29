import { Inject, Injectable } from "@nestjs/common";
import { AppConfig, CONFIG } from "./config";
import type { SessionInfo } from "./types";

export class StalwartError extends Error {
  constructor(public readonly kind: "auth" | "unavailable" | "protocol" | "notfound" | "toolarge", message: string) {
    super(message);
  }
}

// Белый список JMAP-методов: сервер НЕ является открытым прокси к Stalwart.
// Настройки аккаунта, ключи и пароли приложений через него недоступны.
// Email/set и EmailSubmission/set вызываются только из кода контроллеров с жёстко заданными изменениями
// (прочитано, корзина, удаление, создание и отправка своего письма). Identity/get только читает адреса отправителя.
const ALLOWED_METHODS = new Set(["Mailbox/get", "Email/query", "Email/get", "Email/set", "Identity/get", "EmailSubmission/set"]);
const USING = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail", "urn:ietf:params:jmap:submission"];
const MAIL_CAP = "urn:ietf:params:jmap:mail";
// Безопасные символы идентификаторов: в адрес запроса попадает только это
export const ID_RE = /^[A-Za-z0-9._~-]{1,200}$/;

export type JmapCall = [method: string, args: Record<string, unknown>];

/** Пределы, которые объявляет сам Stalwart (null: не объявлены) */
export interface ServerLimits { maxUpload: number | null; maxAttachments: number | null }

@Injectable()
export class StalwartClient {
  private readonly limitsCache = new Map<string, { at: number; v: ServerLimits }>();

  constructor(@Inject(CONFIG) private readonly cfg: AppConfig) {}

  private async request(path: string, email: string, password: string, init: RequestInit = {}, timeoutMs = 10_000): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: "Basic " + Buffer.from(`${email}:${password}`).toString("base64"),
      ...((init.headers as Record<string, string>) ?? {}),
    };
    try {
      // redirect: "manual": никуда сами не переходим; адрес всегда наш внутренний
      return await fetch(this.cfg.stalwartUrl + path, {
        ...init, headers, redirect: "manual", signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new StalwartError("unavailable", "почтовый сервер недоступен");
    }
  }

  /** Проверяет пароль: успех даёт идентификатор аккаунта. Код 402 (нужен код двухфакторки) считаем отказом. */
  async login(email: string, password: string): Promise<{ accountId: string }> {
    const r = await this.request("/jmap/session", email, password);
    if (r.status === 401 || r.status === 402 || r.status === 403) throw new StalwartError("auth", "неверный адрес или пароль");
    if (!r.ok) throw new StalwartError("unavailable", `ответ ${r.status}`);
    const j = (await r.json().catch(() => null)) as {
      primaryAccounts?: Record<string, string>;
      accounts?: Record<string, unknown>;
    } | null;
    const accountId = j?.primaryAccounts?.[MAIL_CAP] ?? Object.keys(j?.accounts ?? {})[0];
    if (typeof accountId !== "string" || !accountId) throw new StalwartError("protocol", "в ответе нет аккаунта");
    return { accountId };
  }

  /** Несколько вызовов JMAP одним запросом от имени пользователя (идентификатор аккаунта подставляем сами).
   *  Ссылки между вызовами: "#ids": { resultOf: "0", name: "Email/query", path: "/ids" } */
  async batch(s: SessionInfo, calls: JmapCall[]): Promise<Record<string, unknown>[]> {
    for (const [method] of calls) {
      if (!ALLOWED_METHODS.has(method)) throw new StalwartError("protocol", `метод не разрешён: ${method}`);
    }
    const r = await this.request("/jmap", s.email, s.password, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        using: USING,
        methodCalls: calls.map(([m, a], i) => [m, { ...a, accountId: s.accountId }, String(i)]),
      }),
    });
    if (r.status === 401 || r.status === 402 || r.status === 403) throw new StalwartError("auth", "доступ отозван");
    if (!r.ok) throw new StalwartError("unavailable", `ответ ${r.status}`);
    const data = (await r.json().catch(() => null)) as { methodResponses?: unknown[][] } | null;
    const out = data?.methodResponses;
    if (!Array.isArray(out) || out.length !== calls.length) throw new StalwartError("protocol", "неполный ответ JMAP");
    return out.map((x) => {
      if (!x || x[0] === "error" || typeof x[1] !== "object" || x[1] === null) throw new StalwartError("protocol", "ошибка метода JMAP");
      return x[1] as Record<string, unknown>;
    });
  }

  /** Один вызов JMAP */
  async call(s: SessionInfo, method: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    return (await this.batch(s, [[method, args]]))[0];
  }

  /** Скачивание содержимого (вложение или письмо целиком). Возвращает поток ответа Stalwart. */
  async download(s: SessionInfo, blobId: string): Promise<Response> {
    if (!ID_RE.test(blobId) || !ID_RE.test(s.accountId)) throw new StalwartError("protocol", "неверный идентификатор");
    const r = await this.request(
      `/jmap/download/${s.accountId}/${blobId}/file?accept=application%2Foctet-stream`, s.email, s.password,
      { headers: { Accept: "*/*" } }, 120_000,
    );
    if (r.status === 401 || r.status === 402 || r.status === 403) throw new StalwartError("auth", "доступ отозван");
    if (r.status === 404) throw new StalwartError("notfound", "не найдено");
    if (!r.ok || !r.body) throw new StalwartError("unavailable", `ответ ${r.status}`);
    return r;
  }

  /** Пределы размера, которые сообщает Stalwart в описании сессии (кэш на 10 минут). Недоступно или не объявлено: null. */
  async limits(s: SessionInfo): Promise<ServerLimits> {
    const hit = this.limitsCache.get(s.accountId);
    if (hit && Date.now() - hit.at < 600_000) return hit.v;
    const r = await this.request("/jmap/session", s.email, s.password);
    if (r.status === 401 || r.status === 402 || r.status === 403) throw new StalwartError("auth", "доступ отозван");
    const j = r.ok ? ((await r.json().catch(() => null)) as { capabilities?: Record<string, Record<string, unknown>> } | null) : null;
    const pos = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
    const v: ServerLimits = {
      maxUpload: pos(j?.capabilities?.["urn:ietf:params:jmap:core"]?.maxSizeUpload),
      maxAttachments: pos(j?.capabilities?.[MAIL_CAP]?.maxSizeAttachmentsPerEmail),
    };
    if (this.limitsCache.size > 500) this.limitsCache.clear();
    this.limitsCache.set(s.accountId, { at: Date.now(), v });
    return v;
  }

  /** Загрузка файла в Stalwart (получаем идентификатор для вложения). Файл целиком в памяти, размер проверен заранее. */
  async upload(s: SessionInfo, type: string, body: Buffer): Promise<{ blobId: string; size: number }> {
    if (!ID_RE.test(s.accountId)) throw new StalwartError("protocol", "неверный идентификатор");
    const r = await this.request(`/jmap/upload/${s.accountId}/`, s.email, s.password, {
      method: "POST", headers: { "Content-Type": type }, body: new Uint8Array(body),
    }, 180_000);
    if (r.status === 401 || r.status === 402 || r.status === 403) throw new StalwartError("auth", "доступ отозван");
    if (r.status === 413) throw new StalwartError("toolarge", "сервер не принял файл: слишком большой");
    if (!r.ok) throw new StalwartError("unavailable", `ответ ${r.status}`);
    const j = (await r.json().catch(() => null)) as { blobId?: unknown; size?: unknown } | null;
    if (typeof j?.blobId !== "string" || !ID_RE.test(j.blobId)) throw new StalwartError("protocol", "в ответе нет идентификатора файла");
    return { blobId: j.blobId, size: typeof j.size === "number" ? j.size : body.length };
  }
}
