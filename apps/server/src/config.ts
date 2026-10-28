// Настройки сервера. Всё, что можно менять без правки кода, берётся из переменных окружения.
export interface AppConfig {
  stalwartUrl: string;      // внутренний адрес Stalwart (адреса из его ответов мы НЕ используем)
  host: string;             // на каком адресе слушать
  port: number;
  allowedDomain: string;    // входить можно только с адресами этого домена
  allowedOrigin: string;    // откуда разрешены запросы изменения (проверка Origin)
  cookieSecure: boolean;    // Secure-cookie с префиксом __Host- (в тестах без https отключается)
  cookieName: string;
  idleMs: number;           // сессия умирает после простоя
  absoluteMs: number;       // и в любом случае через это время
  maxFailPerPair: number;   // неудач на пару «адрес сети + почта» за окно
  maxFailPerIp: number;     // неудач с одного адреса сети за окно
  failWindowMs: number;
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
    idleMs: 30 * 60 * 1000,
    absoluteMs: 12 * 60 * 60 * 1000,
    maxFailPerPair: 5,
    maxFailPerIp: 20,
    failWindowMs: 15 * 60 * 1000,
    ...over,
  };
  cfg.cookieName = cfg.cookieSecure ? "__Host-dvmail_sid" : "dvmail_sid";
  return cfg;
}
