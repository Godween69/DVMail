import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable } from "@nestjs/common";
import type { Request } from "express";
import { AdminConfig, CONFIG } from "./config";

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

// Защита от подделки запросов с чужих сайтов (CSRF) для всего, что меняет состояние:
// 1) обязателен свой заголовок (чужая страница не может отправить его без разрешения браузера);
// 2) Origin, если он есть, должен быть нашим локальным адресом;
// 3) Sec-Fetch-Site, если он есть, не должен быть «cross-site».
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(@Inject(CONFIG) private readonly cfg: AdminConfig) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    if (SAFE.has(req.method)) return true;
    const deny = () => new ForbiddenException({ message: "Запрос отклонён" });
    if (req.headers["x-requested-with"] !== "dvmail-admin") throw deny();
    const origin = req.headers.origin;
    if (origin && !this.cfg.allowedOrigins.includes(origin.toLowerCase())) throw deny();
    const site = req.headers["sec-fetch-site"];
    if (site && site !== "same-origin" && site !== "none") throw deny();
    return true;
  }
}
