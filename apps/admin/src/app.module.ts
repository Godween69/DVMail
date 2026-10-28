import { DynamicModule, Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { AccountsController } from "./accounts.controller";
import { AuthController } from "./auth.controller";
import { AdminConfig, CONFIG } from "./config";
import { CsrfGuard } from "./csrf.guard";
import { HealthController } from "./health.controller";
import { LoginLimiter } from "./login-limiter";
import { SessionGuard } from "./session.guard";
import { SessionStore } from "./session.store";
import { StalwartAdmin } from "./stalwart-admin.client";

@Module({})
export class AppModule {
  static forRoot(cfg: AdminConfig): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController, AuthController, AccountsController],
      providers: [
        { provide: CONFIG, useValue: cfg },
        { provide: APP_GUARD, useClass: CsrfGuard }, // защита от подделки запросов на всех маршрутах
        SessionStore, LoginLimiter, StalwartAdmin, SessionGuard,
      ],
    };
  }
}
