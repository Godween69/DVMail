import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module";
import { AppConfig, loadConfig } from "./config";

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
  app.use((_req: unknown, res: { setHeader(k: string, v: string): void }, next: () => void) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    next();
  });
  app.enableShutdownHooks();
  return { app, cfg };
}
