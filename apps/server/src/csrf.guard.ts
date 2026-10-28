import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable } from "@nestjs/common";
import type { Request } from "express";
import { AppConfig, CONFIG } from "./config";

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

// Защита от подделки запросов с чужих сайтов (CSRF). Для любых запросов, меняющих состояние:
// 1) обязателен свой заголовок (чужая страница не может его отправить без разрешения браузера);
// 2) Origin, если он есть, должен быть нашим сайтом;
// 3) Sec-Fetch-Site, если он есть, не должен быть «cross-site».
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(@Inject(CONFIG) private readonly cfg: AppConfig) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    if (SAFE.has(req.method)) return true;
    const deny = () => new ForbiddenException({ message: "Запрос отклонён" });
    if (req.headers["x-requested-with"] !== "dvmail") throw deny();
    const origin = req.headers.origin;
    if (origin && origin !== this.cfg.allowedOrigin) throw deny();
    const site = req.headers["sec-fetch-site"];
    if (site && site !== "same-origin" && site !== "none") throw deny();
    return true;
  }
}
