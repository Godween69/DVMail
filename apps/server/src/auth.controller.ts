import { Body, Controller, Get, HttpCode, HttpException, Inject, Post, Req, Res, UnauthorizedException, UseGuards } from "@nestjs/common";
import type { Request, Response } from "express";
import { AppConfig, CONFIG } from "./config";
import { buildCookie, readCookie } from "./cookies";
import { LoginLimiter } from "./login-limiter";
import { SessionGuard } from "./session.guard";
import { SessionStore } from "./session.store";
import { StalwartClient, StalwartError } from "./stalwart.client";
import type { SessionRequest } from "./types";

// Для неверного пароля и для несуществующего адреса ответ один и тот же
const BAD = "Неверный адрес или пароль приложения";
const EMAIL_RE = /^[^\s@\x00-\x1f]{1,64}@[a-z0-9.-]{1,190}$/i;

@Controller("api/auth")
export class AuthController {
  constructor(
    @Inject(CONFIG) private readonly cfg: AppConfig,
    private readonly store: SessionStore,
    private readonly limiter: LoginLimiter,
    private readonly stalwart: StalwartClient,
  ) {}

  @Post("login")
  @HttpCode(200)
  async login(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const b = (body ?? {}) as Record<string, unknown>;
    const email = typeof b.email === "string" ? b.email.trim().toLowerCase() : "";
    const password = typeof b.password === "string" ? b.password : "";
    const ip = req.ip ?? "unknown";

    const wait = this.limiter.waitSeconds(ip, email);
    if (wait > 0) {
      res.setHeader("Retry-After", String(wait));
      throw new HttpException({ message: "Слишком много попыток. Подождите и повторите." }, 429);
    }

    const valid =
      email.length <= 254 && EMAIL_RE.test(email) && email.endsWith("@" + this.cfg.allowedDomain) &&
      password.length >= 1 && password.length <= 256 && !/[\x00-\x1f]/.test(password);
    if (!valid) {
      this.limiter.fail(ip, email);
      throw new UnauthorizedException({ message: BAD });
    }

    let accountId: string;
    try {
      ({ accountId } = await this.stalwart.login(email, password));
    } catch (e) {
      if (e instanceof StalwartError && e.kind === "auth") {
        this.limiter.fail(ip, email);
        throw new UnauthorizedException({ message: BAD });
      }
      // сбой самого сервера почты не считаем неудачей пользователя
      throw new HttpException({ message: "Почтовый сервер недоступен, попробуйте позже" }, 502);
    }

    this.limiter.ok(ip, email);
    this.store.destroy(readCookie(req.headers.cookie, this.cfg.cookieName)); // старая сессия не остаётся
    const token = this.store.create({ email, accountId, password });
    res.setHeader("Set-Cookie", buildCookie(this.cfg.cookieName, token, Math.floor(this.cfg.absoluteMs / 1000), this.cfg.cookieSecure));
    return { email };
  }

  @Post("logout")
  @HttpCode(204)
  logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): void {
    this.store.destroy(readCookie(req.headers.cookie, this.cfg.cookieName));
    res.setHeader("Set-Cookie", buildCookie(this.cfg.cookieName, "", 0, this.cfg.cookieSecure));
  }

  @Get("me")
  @UseGuards(SessionGuard)
  me(@Req() req: Request) {
    return { email: (req as SessionRequest).dvSession.email };
  }
}
