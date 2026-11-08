import { Body, Controller, Get, HttpCode, HttpException, Inject, Post, Req, Res, UnauthorizedException, UseGuards } from "@nestjs/common";
import type { Request, Response } from "express";
import { AppConfig, CONFIG } from "./config";
import { buildCookie, readCookie } from "./cookies";
import { ChatChallenge, DvAuthClient } from "./dvauth.client";
import { LoginLimiter } from "./login-limiter";
import { PendingStore } from "./pending.store";
import { SessionGuard } from "./session.guard";
import { SessionStore } from "./session.store";
import { StalwartClient, StalwartError } from "./stalwart.client";
import type { SessionRequest } from "./types";

// Для неверного пароля и для несуществующего адреса ответ один и тот же
// Подсказка про двухфакторку есть всегда: иначе ответ выдал бы, что пароль верный, а не хватает только кода
const BAD = "Неверный адрес или пароль. Если у ящика включена двухфакторная защита, нужен пароль приложения.";
// Для IPv6 лимит считаем по сети /64: владелец сети легко меняет последние 64 бита адреса
export function netKey(ip: string | undefined): string {
  if (!ip) return "unknown";
  const v4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (v4) return v4[1];
  if (!ip.includes(":")) return ip;
  const full = ip.toLowerCase().split("::");
  const head = full[0] ? full[0].split(":") : [];
  const tail = full[1] ? full[1].split(":") : [];
  const groups = full.length === 2 ? [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill("0"), ...tail] : head;
  return groups.slice(0, 4).map((g) => g.padStart(4, "0")).join(":") + "::/64";
}
const EMAIL_RE = /^[^\s@\x00-\x1f]{1,64}@[a-z0-9.-]{1,190}$/i;

@Controller("api/auth")
export class AuthController {
  constructor(
    @Inject(CONFIG) private readonly cfg: AppConfig,
    private readonly store: SessionStore,
    private readonly limiter: LoginLimiter,
    private readonly stalwart: StalwartClient,
    private readonly dvauth: DvAuthClient,
    private readonly pending: PendingStore,
  ) {}

  // Открытие сессии: старая сессия и ожидающий вход закрываются, выдаётся новая кука
  private openSession(req: Request, res: Response, info: { email: string; accountId: string; password: string }): void {
    this.store.destroy(readCookie(req.headers.cookie, this.cfg.cookieName)); // старая сессия не остаётся
    this.pending.destroy(readCookie(req.headers.cookie, this.cfg.cookieNamePending));
    const token = this.store.create(info);
    res.setHeader("Set-Cookie", [
      buildCookie(this.cfg.cookieName, token, Math.floor(this.cfg.absoluteMs / 1000), this.cfg.cookieSecure),
      buildCookie(this.cfg.cookieNamePending, "", 0, this.cfg.cookieSecure),
    ]);
  }

  // Ожидающий вход этого браузера. Нет куки или срок вышел: второй шаг не начинался (401, человек возвращается к паролю).
  private waiting(req: Request) {
    const p = this.pending.get(readCookie(req.headers.cookie, this.cfg.cookieNamePending));
    if (!p) throw new UnauthorizedException({ message: "Время подтверждения вышло. Войдите снова." });
    return p;
  }

  // Второй шаг пройден для этого человека: сессия открывается только если DV Auth подтвердил именно владельца ящика,
  // который вводил пароль в этом браузере.
  private finish(req: Request, res: Response, subject: string): { email: string } {
    const p = this.waiting(req);
    if (subject !== p.accountId) throw new UnauthorizedException({ message: "Подтверждение не подошло. Войдите снова." });
    this.limiter.ok(netKey(req.ip), p.email);
    this.openSession(req, res, p);
    return { email: p.email };
  }

  @Post("login")
  @HttpCode(200)
  async login(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const b = (body ?? {}) as Record<string, unknown>;
    const email = typeof b.email === "string" ? b.email.trim().toLowerCase() : "";
    const password = typeof b.password === "string" ? b.password : "";
    const ip = netKey(req.ip);

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

    // Пароль верный. Если подключён DV Auth, он решает, нужен ли второй шаг. Недоступен: вход закрыт (503), а не открыт.
    if (this.dvauth.enabled) {
      const r = await this.dvauth.call<{ required: boolean; ticket?: string; methods?: string[] }>("POST", "/v1/login/begin", { subject: accountId, ip: req.ip ?? "unknown" });
      if (r.required && r.ticket) {
        this.pending.destroy(readCookie(req.headers.cookie, this.cfg.cookieNamePending));
        const token = this.pending.create({ ticket: r.ticket, email, accountId, password });
        res.setHeader("Set-Cookie", buildCookie(this.cfg.cookieNamePending, token, Math.floor(this.cfg.pendingMs / 1000), this.cfg.cookieSecure));
        return { twoFactor: { methods: r.methods ?? [] } };
      }
    }
    this.limiter.ok(ip, email);
    this.openSession(req, res, { email, accountId, password });
    return { email };
  }

  // Шаг 2а: код из приложения-аутентификатора или запасной код
  @Post("2fa/code")
  @HttpCode(200)
  async code(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const p = this.waiting(req);
    const code = typeof (body as { code?: unknown } | null)?.code === "string" ? (body as { code: string }).code.trim() : "";
    if (code.length < 1 || code.length > 40) throw new UnauthorizedException({ message: "Введите код" });
    const r = await this.dvauth.call<{ subject: string }>("POST", "/v1/login/code", { ticket: p.ticket, code, ip: req.ip ?? "unknown" });
    return this.finish(req, res, r.subject);
  }

  // Шаг 2б: подтверждение в DVChat. start выдаёт QR и число, status опрашивает страница входа.
  @Post("2fa/chat/start")
  @HttpCode(200)
  async chatStart(@Req() req: Request): Promise<ChatChallenge> {
    const p = this.waiting(req);
    return this.dvauth.call("POST", "/v1/login/chat/start", { ticket: p.ticket, ip: req.ip ?? "unknown", agent: String(req.headers["user-agent"] ?? "").slice(0, 200) });
  }

  @Post("2fa/chat/status")
  @HttpCode(200)
  async chatStatus(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<{ state: string; email?: string }> {
    const p = this.waiting(req);
    const r = await this.dvauth.call<{ state: string; subject?: string }>("POST", "/v1/login/chat/status", { ticket: p.ticket });
    if (r.state === "approved" && r.subject) return { state: "approved", ...this.finish(req, res, r.subject) };
    return { state: r.state };
  }

  // «Назад» на втором шаге: ожидающий вход забывается
  @Post("2fa/cancel")
  @HttpCode(204)
  cancel(@Req() req: Request, @Res({ passthrough: true }) res: Response): void {
    this.pending.destroy(readCookie(req.headers.cookie, this.cfg.cookieNamePending));
    res.setHeader("Set-Cookie", buildCookie(this.cfg.cookieNamePending, "", 0, this.cfg.cookieSecure));
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
