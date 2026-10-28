import { Controller, Get, HttpException, Req, UnauthorizedException, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { SessionGuard } from "./session.guard";
import { SessionStore } from "./session.store";
import { StalwartClient, StalwartError } from "./stalwart.client";
import type { SessionRequest } from "./types";

@Controller("api")
@UseGuards(SessionGuard)
export class MailController {
  constructor(private readonly stalwart: StalwartClient, private readonly store: SessionStore) {}

  @Get("mailboxes")
  async mailboxes(@Req() req: Request) {
    const r = req as SessionRequest;
    try {
      const out = await this.stalwart.call(r.dvSession, "Mailbox/get", {
        properties: ["id", "name", "role", "parentId", "totalEmails", "unreadEmails"],
      });
      const list = Array.isArray(out.list) ? (out.list as Record<string, unknown>[]) : [];
      // отдаём браузеру только нужные поля
      return {
        mailboxes: list.map((m) => ({
          id: m.id, name: m.name, role: m.role ?? null, parentId: m.parentId ?? null,
          total: m.totalEmails ?? 0, unread: m.unreadEmails ?? 0,
        })),
      };
    } catch (e) {
      if (e instanceof StalwartError && e.kind === "auth") {
        this.store.destroy(r.dvToken); // пароль приложения отозван: сессию закрываем
        throw new UnauthorizedException({ message: "Требуется вход" });
      }
      throw new HttpException({ message: "Почтовый сервер недоступен, попробуйте позже" }, 502);
    }
  }
}
