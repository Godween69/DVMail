import { resolve } from "node:path";

// Настройки сервера. Всё, что можно менять без правки кода, берётся из переменных окружения.
export interface AppConfig {
  stalwartUrl: string;      // внутренний адрес Stalwart (адреса из его ответов мы НЕ используем)
  host: string;             // на каком адресе слушать
  port: number;
  allowedDomain: string;    // входить можно только с адресами этого домена
  allowedOrigin: string;    // откуда разрешены запросы изменения (проверка Origin)
  cookieSecure: boolean;    // Secure-cookie с префиксом __Host- (в тестах без https отключается)
  cookieName: string;
  webRoot: string;          // папка со собранным сайтом (apps/web/dist)
  idleMs: number;           // сессия умирает после простоя
  absoluteMs: number;       // и в любом случае через это время
  maxFailPerPair: number;   // неудач на пару «адрес сети + почта» за окно
  maxFailPerIp: number;     // неудач с одного адреса сети за окно
  failWindowMs: number;
  maxRequestsPerMinute: number; // запросов в минуту с одной сессии (обычная работа на порядок меньше)
  authUrl: string;          // внутренний адрес DV Auth (второй фактор); пусто: второй фактор не подключён
  authSecret: string;       // секрет этого приложения в DV Auth (не короче 32 символов)
  pendingMs: number;        // сколько человек может проходить второй шаг после пароля
  cookieNamePending: string;
}

export const CONFIG = Symbol("CONFIG");

export function loadConfig(over: Partial<AppConfig> = {}): AppConfig {
  const e = process.env;
  const cfg: AppConfig = {
    stalwartUrl: (e.STALWART_URL ?? "http://dvmail-stalwart:8080").replace(/\/+$/, ""),
    host: e.HOST ?? "127.0.0.1",
    port: Number(e.PORT ?? 3000),
    allowedDomain: (e.ALLOWED_DOMAIN ?? "dvbstudio.ru").toLowerCase(),
    allowedOrigin: e.ALLOWED_ORIGIN ?? "https://webmail.dvbstudio.ru",
    cookieSecure: (e.COOKIE_SECURE ?? "true") !== "false",
    cookieName: "",
    webRoot: e.WEB_ROOT ?? resolve(__dirname, "../../web/dist"),
    idleMs: 30 * 60 * 1000,
    absoluteMs: 12 * 60 * 60 * 1000,
    maxFailPerPair: 5,
    maxFailPerIp: 20,
    failWindowMs: 15 * 60 * 1000,
    maxRequestsPerMinute: 300,
    authUrl: (e.DVMAIL_AUTH_URL ?? "").trim().replace(/\/+$/, ""),
    authSecret: (e.DVMAIL_AUTH_SECRET ?? "").trim(),
    pendingMs: 5 * 60 * 1000,
    cookieNamePending: "",
    ...over,
  };
  cfg.cookieName = cfg.cookieSecure ? "__Host-dvmail_sid" : "dvmail_sid";
  cfg.cookieNamePending = cfg.cookieSecure ? "__Host-dvmail_pend" : "dvmail_pend";
  // Адрес и секрет DV Auth задаются только вместе: половинная настройка почти наверняка ошибка,
  // а молча работать без второго фактора при такой ошибке нельзя.
  if ((cfg.authUrl === "") !== (cfg.authSecret === "")) throw new Error("DVMAIL_AUTH_URL и DVMAIL_AUTH_SECRET задаются вместе или не задаются вовсе");
  if (cfg.authSecret !== "" && cfg.authSecret.length < 32) throw new Error("DVMAIL_AUTH_SECRET короче 32 символов");
  if (cfg.authUrl !== "" && !/^https?:\/\/[^\s/]+(:\d+)?$/.test(cfg.authUrl)) throw new Error("DVMAIL_AUTH_URL должен быть вида http://хост:порт");
  return cfg;
}
