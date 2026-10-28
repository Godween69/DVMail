import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";
import { AdminConfig, CONFIG } from "./config";
import { readCookie } from "./cookies";
import { SessionStore } from "./session.store";

// Пускает только с действующей сессией
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly store: SessionStore, @Inject(CONFIG) private readonly cfg: AdminConfig) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    if (!this.store.valid(readCookie(req.headers.cookie, this.cfg.cookieName))) {
      throw new UnauthorizedException({ message: "Требуется вход" });
    }
    return true;
  }
}
