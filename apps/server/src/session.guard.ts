import { CanActivate, ExecutionContext, HttpException, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import type { Request, Response } from "express";
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
    const wait = this.store.throttle(token);
    if (wait > 0) {
      ctx.switchToHttp().getResponse<Response>().setHeader("Retry-After", String(wait));
      throw new HttpException({ message: "Слишком много запросов. Подождите немного." }, 429);
    }
    (req as SessionRequest).dvSession = session;
    (req as SessionRequest).dvToken = token;
    return true;
  }
}
