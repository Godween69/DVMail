import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";
import { AppConfig, CONFIG } from "./config";
import { readCookie } from "./cookies";
import { SessionStore } from "./session.store";
import type { SessionRequest } from "./types";

// Пускает только с действующей сессией и кладёт её данные в запрос
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly store: SessionStore, @Inject(CONFIG) private readonly cfg: AppConfig) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    const token = readCookie(req.headers.cookie, this.cfg.cookieName);
    const session = this.store.get(token);
    if (!session || !token) throw new UnauthorizedException({ message: "Требуется вход" });
    (req as SessionRequest).dvSession = session;
    (req as SessionRequest).dvToken = token;
    return true;
  }
}
