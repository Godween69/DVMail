// Настройки админки. Всё, что можно менять без правки кода, берётся из переменных окружения.
// Секреты (ключ Stalwart и хеш пароля админки) читаются из файлов: в окружение и в логи они не попадают.
import { readFileSync } from "node:fs";

export interface AdminConfig {
  stalwartUrl: string;       // внутренний адрес Stalwart
  stalwartToken: string;     // API-ключ служебного аккаунта dvadmin
  passwordHash: string;      // scrypt-хеш пароля входа в админку
  host: string;              // на каком адресе слушать внутри контейнера
  port: number;
  domain: string;            // ящики создаются только в этом домене
  allowedHosts: string[];    // допустимые значения заголовка Host (защита от DNS rebinding)
  allowedOrigins: string[];  // допустимые Origin для запросов изменения
  protectedNames: string[];  // ящики, которые админка не удаляет
  reservedNames: string[];   // имена, которые нельзя создавать
  cookieName: string;
  idleMs: number;            // сессия умирает после простоя
  absoluteMs: number;        // и в любом случае через это время
  maxFailPerIp: number;      // неудачных входов с одного адреса за окно
  maxFailTotal: number;      // неудачных входов всего за окно (с любых адресов)
  failWindowMs: number;
}

export const CONFIG = Symbol("CONFIG");

function readSecret(path: string, what: string): string {
  try {
    const v = readFileSync(path, "utf8").trim();
    if (v) return v;
  } catch {
    /* ниже понятная ошибка */
  }
  throw new Error(`Не найден секрет «${what}» в файле ${path}`);
}

const parseList = (v: string | undefined, def: string[]): string[] =>
  v ? v.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean) : def;

export function loadConfig(over: Partial<AdminConfig> = {}): AdminConfig {
  const e = process.env;
  const port = Number(e.PORT ?? 3100);
  const hosts = parseList(e.ADMIN_HOSTS, [`127.0.0.1:${port}`, `localhost:${port}`]);
  const cfg: AdminConfig = {
    stalwartUrl: (e.STALWART_URL ?? "http://dvmail-stalwart:8080").replace(/\/+$/, ""),
    stalwartToken: "",
    passwordHash: "",
    host: e.HOST ?? "127.0.0.1",
    port,
    domain: (e.ALLOWED_DOMAIN ?? "dvbstudio.ru").toLowerCase(),
    allowedHosts: hosts,
    allowedOrigins: hosts.map((h) => "http://" + h),
    protectedNames: parseList(e.PROTECTED_NAMES, ["hello"]),
    reservedNames: ["admin", "administrator", "root", "postmaster", "abuse", "hostmaster", "webmaster", "dvadmin"],
    cookieName: "dvmail_admin_sid",
    idleMs: 15 * 60 * 1000,
    absoluteMs: 4 * 60 * 60 * 1000,
    maxFailPerIp: 5,
    maxFailTotal: 15,
    failWindowMs: 15 * 60 * 1000,
    ...over,
  };
  if (!cfg.stalwartToken) {
    cfg.stalwartToken = readSecret(e.STALWART_TOKEN_FILE ?? "/run/secrets/stalwart_token", "ключ Stalwart");
  }
  if (!cfg.passwordHash) {
    cfg.passwordHash = readSecret(e.ADMIN_PASSWORD_HASH_FILE ?? "/run/secrets/admin_password_hash", "хеш пароля админки");
  }
  return cfg;
}
