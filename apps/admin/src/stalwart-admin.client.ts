import { HttpException, Inject, Injectable } from "@nestjs/common";
import { AdminConfig, CONFIG } from "./config";
import { generatePassword } from "./password";

// Управление Stalwart через JMAP (формат проверен на настоящем сервере 0.16: POST /jmap, ключ в Bearer).
const USING = ["urn:ietf:params:jmap:core", "urn:stalwart:jmap"];
// Белый список методов: админка не открытый прокси, ничего кроме ящиков и домена она не умеет.
const ALLOWED = new Set(["x:Domain/query", "x:Domain/get", "x:Account/query", "x:Account/get", "x:Account/set"]);

type Call = [string, Record<string, unknown>, string];
type Reply = [string, Record<string, any>, string];

export interface AccountInfo {
  id: string;
  name: string;
  email: string;
  role: string;
  description: string | null;
  protected: boolean;
}

const bad = (status: number, message: string) => new HttpException({ message }, status);

@Injectable()
export class StalwartAdmin {
  private domainIdCache?: string;

  constructor(@Inject(CONFIG) private readonly cfg: AdminConfig) {}

  private async jmap(calls: Call[]): Promise<Reply[]> {
    for (const c of calls) if (!ALLOWED.has(c[0])) throw new Error("метод не разрешён: " + c[0]);
    let r: Response;
    try {
      r = await fetch(this.cfg.stalwartUrl + "/jmap", {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
        headers: {
          Authorization: "Bearer " + this.cfg.stalwartToken,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ using: USING, methodCalls: calls }),
      });
    } catch {
      throw bad(502, "Почтовый сервер недоступен");
    }
    if (r.status === 401 || r.status === 403) throw bad(502, "Stalwart не принял ключ администратора (ключ dvadmin)");
    if (!r.ok) throw bad(502, `Почтовый сервер ответил кодом ${r.status}`);
    const data = (await r.json().catch(() => null)) as { methodResponses?: Reply[] } | null;
    const resp = data?.methodResponses;
    if (!Array.isArray(resp)) throw bad(502, "Непонятный ответ почтового сервера");
    for (const m of resp) {
      if (m[0] === "error") throw bad(502, "Почтовый сервер вернул ошибку: " + String(m[1]?.type ?? "неизвестно"));
    }
    return resp;
  }

  private async domainId(): Promise<string> {
    if (this.domainIdCache) return this.domainIdCache;
    const resp = await this.jmap([
      ["x:Domain/query", {}, "q"],
      ["x:Domain/get", { "#ids": { resultOf: "q", name: "x:Domain/query", path: "/ids" }, properties: ["name"] }, "g"],
    ]);
    const found = (resp[1][1].list as Array<{ id: string; name: string }>).find((d) => d.name === this.cfg.domain);
    if (!found) throw bad(502, `Домен ${this.cfg.domain} не найден в Stalwart`);
    this.domainIdCache = found.id;
    return found.id;
  }

  private toInfo(a: { id: string; name: string; roles?: { "@type"?: string }; description?: string | null }): AccountInfo {
    const role = a.roles?.["@type"] ?? "Group";
    return {
      id: a.id,
      name: a.name,
      email: `${a.name}@${this.cfg.domain}`,
      role,
      description: a.description ?? null,
      protected: role !== "User" || this.cfg.protectedNames.includes(a.name),
    };
  }

  async list(): Promise<AccountInfo[]> {
    const resp = await this.jmap([
      ["x:Account/query", {}, "q"],
      [
        "x:Account/get",
        { "#ids": { resultOf: "q", name: "x:Account/query", path: "/ids" }, properties: ["name", "roles", "description"] },
        "g",
      ],
    ]);
    return (resp[1][1].list as any[]).map((a) => this.toInfo(a)).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Создаёт ящик с ролью User и случайным паролем. Пароль возвращается один раз и нигде не сохраняется. */
  async create(name: string, description: string | null): Promise<{ id: string; email: string; password: string; loginOk: boolean }> {
    const domainId = await this.domainId();
    const password = generatePassword();
    const obj: Record<string, unknown> = {
      "@type": "User",
      name,
      domainId,
      roles: { "@type": "User" },
      credentials: { "0": { "@type": "Password", secret: password } },
    };
    if (description) obj.description = description;
    const resp = await this.jmap([["x:Account/set", { create: { p1: obj } }, "s"]]);
    const res = resp[0][1] as { created?: Record<string, { id?: string }>; notCreated?: Record<string, { type?: string }> };
    const id = res.created?.p1?.id;
    if (!id) throw bad(502, "Ящик не создан: " + String(res.notCreated?.p1?.type ?? "причина неизвестна"));
    const email = `${name}@${this.cfg.domain}`;
    return { id, email, password, loginOk: await this.verifyLogin(email, password) };
  }

  /** Удаляет ящик (и письма в нём). Защита: имя должно совпасть, роль только User, защищённые не трогаем. */
  async destroy(id: string, confirmName: string): Promise<void> {
    const resp = await this.jmap([["x:Account/get", { ids: [id], properties: ["name", "roles", "description"] }, "g"]]);
    const found = (resp[0][1].list as any[])[0];
    if (!found) throw bad(404, "Такого ящика нет");
    const info = this.toInfo(found);
    if (info.name !== confirmName) throw bad(400, "Имя для подтверждения не совпало");
    if (info.protected) throw bad(403, "Это защищённый ящик, админка его не удаляет");
    const out = await this.jmap([["x:Account/set", { destroy: [id] }, "d"]]);
    if (!(out[0][1].destroyed as string[] | undefined)?.includes(id)) throw bad(502, "Ящик не удалён");
  }

  /**
   * Сбрасывает основной пароль ящика: новый случайный пароль, показывается один раз.
   * Меняется ТОЛЬКО поле secret основного пароля точечной правкой (credentials/<ключ>/secret):
   * пароли приложений и двухфакторка остаются как были (Stalwart отдаёт секреты скрытыми,
   * поэтому заменять весь список учётных данных нельзя, он бы потерял пароли приложений).
   */
  async resetPassword(id: string, confirmName: string): Promise<{ id: string; email: string; password: string; loginOk: boolean }> {
    const resp = await this.jmap([["x:Account/get", { ids: [id], properties: ["name", "roles", "description", "credentials"] }, "g"]]);
    const found = (resp[0][1].list as any[])[0];
    if (!found) throw bad(404, "Такого ящика нет");
    const info = this.toInfo(found);
    if (info.name !== confirmName) throw bad(400, "Имя для подтверждения не совпало");
    if (info.protected) throw bad(403, "Это защищённый ящик, админка не меняет его пароль");
    const keys = Object.entries((found.credentials ?? {}) as Record<string, { "@type"?: string }>)
      .filter(([, c]) => c?.["@type"] === "Password")
      .map(([k]) => k);
    if (keys.length !== 1 || !/^[A-Za-z0-9_-]{1,32}$/.test(keys[0])) {
      throw bad(502, "У ящика нет единственного основного пароля, сброс не выполнен");
    }
    const password = generatePassword();
    const out = await this.jmap([["x:Account/set", { update: { [id]: { [`credentials/${keys[0]}/secret`]: password } } }, "s"]]);
    const res = out[0][1] as { updated?: Record<string, unknown>; notUpdated?: Record<string, { type?: string }> };
    if (!res.updated || !(id in res.updated)) throw bad(502, "Пароль не изменён: " + String(res.notUpdated?.[id]?.type ?? "причина неизвестна"));
    return { id, email: info.email, password, loginOk: await this.verifyLogin(info.email, password) };
  }

  /** Проверка входа по паролю (как сделает почтовый клиент) */
  async verifyLogin(email: string, password: string): Promise<boolean> {
    try {
      const r = await fetch(this.cfg.stalwartUrl + "/jmap/session", {
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
        headers: { Authorization: "Basic " + Buffer.from(`${email}:${password}`).toString("base64") },
      });
      return r.status === 200;
    } catch {
      return false;
    }
  }
}
