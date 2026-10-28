import { Body, Controller, Get, HttpCode, HttpException, Inject, Post, Req, Res, UnauthorizedException, UseGuards } from "@nestjs/common";
import type { Request, Response } from "express";
import { AdminConfig, CONFIG } from "./config";
import { buildCookie, readCookie } from "./cookies";
import { LoginLimiter } from "./login-limiter";
import { verifyPassword } from "./password";
import { SessionGuard } from "./session.guard";
import { SessionStore } from "./session.store";

@Controller("api")
export class AuthController {
  constructor(
    @Inject(CONFIG) private readonly cfg: AdminConfig,
    private readonly store: SessionStore,
    private readonly limiter: LoginLimiter,
  ) {}

  @Post("login")
  @HttpCode(200)
  async login(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const b = (body ?? {}) as Record<string, unknown>;
    const password = typeof b.password === "string" ? b.password : "";
    const ip = req.ip ?? "unknown";

    const wait = this.limiter.waitSeconds(ip);
    if (wait > 0) {
      res.setHeader("Retry-After", String(wait));
      throw new HttpException({ message: "Слишком много попыток. Подождите и повторите." }, 429);
    }
    if (password.length < 1 || password.length > 256 || !(await verifyPassword(password, this.cfg.passwordHash))) {
      this.limiter.fail(ip);
      throw new UnauthorizedException({ message: "Неверный пароль" });
    }
    this.limiter.ok(ip);
    this.store.destroy(readCookie(req.headers.cookie, this.cfg.cookieName)); // старая сессия не остаётся
    const token = this.store.create();
    res.setHeader("Set-Cookie", buildCookie(this.cfg.cookieName, token, Math.floor(this.cfg.absoluteMs / 1000)));
    return { ok: true };
  }

  @Post("logout")
  @HttpCode(204)
  logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): void {
    this.store.destroy(readCookie(req.headers.cookie, this.cfg.cookieName));
    res.setHeader("Set-Cookie", buildCookie(this.cfg.cookieName, "", 0));
  }

  @Get("me")
  @UseGuards(SessionGuard)
  me() {
    return { ok: true, domain: this.cfg.domain };
  }
}
