import { DynamicModule, Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { AttachmentRegistry } from "./attachments";
import { AttachmentsController } from "./attachments.controller";
import { AuthController } from "./auth.controller";
import { AppConfig, CONFIG } from "./config";
import { CsrfGuard } from "./csrf.guard";
import { HealthController } from "./health.controller";
import { LoginLimiter } from "./login-limiter";
import { MailController } from "./mail.controller";
import { SendController } from "./send.controller";
import { SessionGuard } from "./session.guard";
import { SessionStore } from "./session.store";
import { StalwartClient } from "./stalwart.client";

@Module({})
export class AppModule {
  static forRoot(cfg: AppConfig): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController, AuthController, MailController, SendController, AttachmentsController],
      providers: [
        { provide: CONFIG, useValue: cfg },
        { provide: APP_GUARD, useClass: CsrfGuard }, // защита от подделки запросов на всех маршрутах
        SessionStore, LoginLimiter, StalwartClient, SessionGuard, AttachmentRegistry,
      ],
    };
  }
}
