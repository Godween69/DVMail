import { Body, Controller, Delete, Get, HttpCode, HttpException, NotFoundException, Post, Req, Res, UseGuards } from "@nestjs/common";
import type { Request, Response } from "express";
import { netKey } from "./auth.controller";
import { ChatChallenge, DvAuthClient, FactorStatus } from "./dvauth.client";
import { LoginLimiter } from "./login-limiter";
import { SessionGuard } from "./session.guard";
import { StalwartClient, StalwartError } from "./stalwart.client";
import type { SessionRequest } from "./types";

const str = (o: unknown, k: string, max: number): string => {
  const v = (o as Record<string, unknown> | null)?.[k];
  return typeof v === "string" && v.length <= max ? v : "";
};

// Настройки второго фактора. Сами факторы хранит DV Auth; здесь только проверка прав.
// Все действия под сессией; опасные ещё и с паролем (а если включены коды из приложения, то и с кодом).
// Неверный пароль или код здесь отвечают 403, а не 401: 401 значит «сессия закончилась» и выбрасывает человека на вход.
@Controller("api/auth/security")
@UseGuards(SessionGuard)
export class SecurityController {
  constructor(
    private readonly dvauth: DvAuthClient,
    private readonly stalwart: StalwartClient,
    private readonly limiter: LoginLimiter,
  ) {}

  private need(): void {
    if (!this.dvauth.enabled) throw new NotFoundException({ message: "Второй фактор на этом сервере не подключён" });
  }

  private ip(req: Request): string { return req.ip ?? "unknown"; }
  private s(req: Request) { return (req as SessionRequest).dvSession; }

  // Пароль приложения проверяет сам Stalwart; неудачи считаются тем же ограничителем, что и вход.
  private async confirmPassword(req: Request, body: unknown): Promise<void> {
    const { email } = this.s(req);
    const net = netKey(req.ip);
    const wait = this.limiter.waitSeconds(net, email);
    if (wait > 0) throw new HttpException({ message: "Слишком много попыток. Подождите и повторите." }, 429);
    const password = str(body, "password", 256);
    const bad = new HttpException({ message: "Неверный пароль" }, 403);
    if (!password) throw bad;
    try {
      const r = await this.stalwart.login(email, password);
      if (r.accountId !== this.s(req).accountId) throw bad;
    } catch (e) {
      if (e instanceof HttpException) throw e;
      if (e instanceof StalwartError && e.kind === "auth") { this.limiter.fail(net, email); throw bad; }
      throw new HttpException({ message: "Почтовый сервер недоступен, попробуйте позже" }, 502);
    }
    this.limiter.ok(net, email);
  }

  private async confirmFactor(req: Request, body: unknown): Promise<void> {
    await this.confirmPassword(req, body);
    const st = await this.dvauth.status(this.s(req).accountId);
    if (!st.totpEnabled) return;
    const code = str(body, "code", 40);
    if (!code) throw new HttpException({ message: "Нужен действующий код из приложения или запасной код" }, 403);
    try {
      await this.dvauth.call("POST", "/v1/check", { subject: this.s(req).accountId, code, ip: this.ip(req) });
    } catch (e) {
      // неверный код: 403 (не 401, чтобы не закрыть сессию), блокировку 429 и недоступность 503 оставляем как есть
      if (e instanceof HttpException && e.getStatus() === 401) throw new HttpException({ message: "Неверный код" }, 403);
      throw e;
    }
  }

  private subject(req: Request): { subject: string } { return { subject: this.s(req).accountId }; }

  @Get()
  async get(@Req() req: Request): Promise<Partial<FactorStatus> & { available: boolean }> {
    if (!this.dvauth.enabled) return { available: false };
    return { available: true, ...(await this.dvauth.status(this.s(req).accountId)) };
  }

  @Post("totp/begin")
  @HttpCode(200)
  async totpBegin(@Body() body: unknown, @Req() req: Request): Promise<{ secret: string; uri: string }> {
    this.need();
    await this.confirmPassword(req, body);
    return this.dvauth.call("POST", "/v1/totp/begin", { ...this.subject(req), label: this.s(req).email });
  }

  @Post("totp/enable")
  @HttpCode(200)
  async totpEnable(@Body() body: unknown, @Req() req: Request): Promise<{ recoveryCodes: string[] | null }> {
    this.need();
    const code = str(body, "code", 6);
    if (!/^\d{6}$/.test(code)) throw new HttpException({ message: "Введите шесть цифр из приложения" }, 400);
    return this.dvauth.call("POST", "/v1/totp/enable", { ...this.subject(req), code });
  }

  @Post("totp/disable")
  @HttpCode(200)
  async totpDisable(@Body() body: unknown, @Req() req: Request): Promise<{ ok: true }> {
    this.need();
    await this.confirmFactor(req, body);
    return this.dvauth.call("POST", "/v1/totp/disable", this.subject(req));
  }

  @Post("recovery/new")
  @HttpCode(200)
  async recoveryNew(@Body() body: unknown, @Req() req: Request): Promise<{ recoveryCodes: string[] }> {
    this.need();
    await this.confirmFactor(req, body);
    return this.dvauth.call("POST", "/v1/recovery/new", this.subject(req));
  }

  @Post("chat/start")
  @HttpCode(200)
  async chatStart(@Body() body: unknown, @Req() req: Request): Promise<ChatChallenge> {
    this.need();
    await this.confirmFactor(req, body);
    return this.dvauth.call("POST", "/v1/chat/link/start", { ...this.subject(req), ip: this.ip(req), agent: String(req.headers["user-agent"] ?? "").slice(0, 200) });
  }

  @Post("chat/status")
  @HttpCode(200)
  async chatStatus(@Req() req: Request): Promise<unknown> {
    this.need();
    return this.dvauth.call("POST", "/v1/chat/link/status", this.subject(req));
  }

  @Delete("chat")
  async chatUnlink(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<{ ok: true }> {
    this.need();
    await this.confirmFactor(req, body);
    res.status(200);
    return this.dvauth.call("POST", "/v1/chat/unlink", this.subject(req));
  }
}

