import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { json, raw } from "express";
import type { Request, Response, NextFunction } from "express";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { AppModule } from "./app.module";
import { AttachmentRegistry, MAX_FILE } from "./attachments";
import { AppConfig, loadConfig } from "./config";
import { readCookie } from "./cookies";
import { SessionStore } from "./session.store";

// Политика страницы: только свои скрипты и стили, без встроенного кода. Картинки только свои и data:
// (внешние картинки из писем не загружаются). Та же политика стоит на шлюзе, здесь она действует и без него.
const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:", "connect-src 'self'",
  "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
].join("; ");

// Общая сборка приложения: используется и боевым запуском, и тестами
export async function createApp(over: Partial<AppConfig> = {}) {
  const cfg = loadConfig(over);
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(cfg), {
    logger: process.env.DVMAIL_LOG === "quiet" ? false : ["error", "warn", "log"],
    bodyParser: false,
  });
  app.disable("x-powered-by");                         // не рассказываем, на чём работаем
  app.set("trust proxy", "loopback, uniquelocal");     // настоящий адрес берём только от своих прокси
  // Тело письма больше обычных запросов: для отправки свой предел (раньше общего разбора), для остального 16 КБ
  app.use("/api/send", json({ limit: "256kb" }));
  // Загрузка файла: тело до 25 МБ. Чтобы чужой не заставил сервер принимать большие тела, ДО разбора тела проверяем
  // свой заголовок, Origin, действующую сессию, объявленный размер и число одновременных загрузок.
  const store = app.get(SessionStore);
  const reg = app.get(AttachmentRegistry);
  const reject = (res: Response, code: number, message: string) => { res.status(code).json({ message }); };
  app.use("/api/attachments", (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== "POST") return next();
    if (req.headers["x-requested-with"] !== "dvmail") return reject(res, 403, "Запрос отклонён");
    const origin = req.headers.origin, site = req.headers["sec-fetch-site"];
    if ((origin && origin !== cfg.allowedOrigin) || (site && site !== "same-origin" && site !== "none")) return reject(res, 403, "Запрос отклонён");
    const token = readCookie(req.headers.cookie, cfg.cookieName);
    if (!token || !store.get(token)) return reject(res, 401, "Требуется вход");
    const len = Number(req.headers["content-length"]);
    if (!Number.isFinite(len)) return reject(res, 411, "Нужен размер файла");
    if (len === 0) return reject(res, 400, "Файл пустой");
    if (len > MAX_FILE + 1024) return reject(res, 413, "Файл слишком большой");
    if (!reg.acquire(token)) return reject(res, 429, "Дождитесь окончания предыдущих загрузок");
    let freed = false;
    const free = () => { if (!freed) { freed = true; reg.release(token); } };
    res.on("close", free);
    next();
  });
  app.use("/api/attachments", raw({ type: () => true, limit: MAX_FILE + 1024 }));
  app.useBodyParser("json", { limit: "16kb" });        // тела запросов маленькие
  app.use((_req: unknown, res: Response, next: NextFunction) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", CSP);
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
    next();
  });

  // Сайт (React): файлы с хешем в имени кэшируются надолго, страница и остальное нет
  const index = join(cfg.webRoot, "index.html");
  if (existsSync(index)) {
    app.use("/assets", (_req: Request, res: Response, next: NextFunction) => {
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      next();
    });
    app.useStaticAssets(cfg.webRoot, { index: false, dotfiles: "ignore" });
    // Любой другой адрес без расширения открывает страницу приложения (маршруты внутри React)
    app.use((req: Request, res: Response, next: NextFunction) => {
      const api = req.path === "/health" || req.path.startsWith("/api/");
      if ((req.method !== "GET" && req.method !== "HEAD") || api || /\.[A-Za-z0-9]+$/.test(req.path)) return next();
      res.sendFile(index);
    });
  }
  app.enableShutdownHooks();
  return { app, cfg };
}
