import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { Request, Response, NextFunction } from "express";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { AppModule } from "./app.module";
import { AppConfig, loadConfig } from "./config";

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
