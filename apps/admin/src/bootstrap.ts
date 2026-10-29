import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { NextFunction, Request, Response } from "express";
import { join } from "node:path";
import { AppModule } from "./app.module";
import { AdminConfig, loadConfig } from "./config";

// Общая сборка приложения: используется и боевым запуском, и тестами
export async function createApp(over: Partial<AdminConfig> = {}) {
  const cfg = loadConfig(over);
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(cfg), {
    logger: process.env.DVMAIL_LOG === "quiet" ? false : ["error", "warn", "log"],
    bodyParser: false,
  });
  app.disable("x-powered-by");
  // trust proxy не включаем: админка открывается напрямую, адрес клиента берём только из соединения
  app.useBodyParser("json", { limit: "4kb" });

  // 1) Проверка Host для всего (и страницы, и API): защита от DNS rebinding.
  //    Без неё чужой сайт мог бы заставить браузер обратиться к локальному адресу под своим именем.
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (!cfg.allowedHosts.includes((req.headers.host ?? "").toLowerCase())) {
      res.status(403).type("text/plain").send("Forbidden");
      return;
    }
    // 2) Заголовки безопасности на каждый ответ
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; " +
        "base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    );
    next();
  });

  // Страница админки: простые файлы без сборки и без чужих библиотек
  app.useStaticAssets(join(__dirname, "..", "public"), {
    index: ["index.html"],
    setHeaders: (res) => res.setHeader("Cache-Control", "no-store"), // страницу не кэшируем
  });
  app.enableShutdownHooks();
  return { app, cfg };
}
