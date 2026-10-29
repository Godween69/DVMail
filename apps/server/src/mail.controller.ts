import {
  BadRequestException, Body, Controller, Get, HttpCode, HttpException, NotFoundException, Param, Post, Query, Req, Res,
  UnauthorizedException, UseGuards,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { Readable } from "node:stream";
import { SessionGuard } from "./session.guard";
import { SessionStore } from "./session.store";
import { ID_RE, StalwartClient, StalwartError } from "./stalwart.client";
import type { SessionInfo, SessionRequest } from "./types";

type Obj = Record<string, unknown>;
interface Addr { name: string | null; email: string }
interface Part { partId?: string; blobId?: string; name?: string | null; type?: string; size?: number; disposition?: string | null }

const LIST_PROPS = ["id", "threadId", "keywords", "from", "to", "subject", "receivedAt", "preview", "hasAttachment", "size"];
const OPEN_PROPS = [
  "id", "threadId", "mailboxIds", "keywords", "from", "to", "cc", "replyTo", "subject", "receivedAt", "sentAt", "size",
  "blobId", "bodyStructure", "textBody", "htmlBody", "attachments", "bodyValues",
];
const MAX_BODY = 2_000_000; // байт текста письма, который отдаём в браузер

const str = (v: unknown, max = 1000): string => (typeof v === "string" ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").slice(0, max) : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const addrs = (v: unknown): Addr[] =>
  Array.isArray(v) ? (v as Obj[]).filter((a) => a && typeof a.email === "string").slice(0, 50).map((a) => ({ name: a.name ? str(a.name, 200) : null, email: str(a.email, 320) })) : [];
const hasKw = (v: unknown, k: string): boolean => !!(v && typeof v === "object" && (v as Obj)[k]);

// Безопасное имя файла: без путей и управляющих символов, до 150 знаков
function fileName(raw: string, fallback: string): string {
  const clean = raw.replace(/[\u0000-\u001f\u007f\\/:*?"<>|]/g, "_").replace(/^\.+/, "_").trim().slice(0, 150);
  return clean || fallback;
}
const asciiName = (n: string) => n.replace(/[^\x20-\x7e]/g, "_").replace(/["%\\]/g, "_");

@Controller("api")
@UseGuards(SessionGuard)
export class MailController {
  constructor(private readonly stalwart: StalwartClient, private readonly store: SessionStore) {}

  // Общая обработка ошибок Stalwart: отозванный доступ закрывает сессию, остальное это 502
  private async guarded<T>(req: Request, fn: (s: SessionInfo) => Promise<T>): Promise<T> {
    const r = req as SessionRequest;
    try {
      return await fn(r.dvSession);
    } catch (e) {
      if (e instanceof HttpException) throw e;
      if (e instanceof StalwartError && e.kind === "auth") {
        this.store.destroy(r.dvToken);
        throw new UnauthorizedException({ message: "Требуется вход" });
      }
      if (e instanceof StalwartError && e.kind === "notfound") throw new NotFoundException({ message: "Письмо не найдено" });
      throw new HttpException({ message: "Почтовый сервер недоступен, попробуйте позже" }, 502);
    }
  }

  private checkId(id: string): void {
    if (!ID_RE.test(id)) throw new BadRequestException({ message: "Неверный идентификатор" });
  }

  @Get("mailboxes")
  async mailboxes(@Req() req: Request) {
    return this.guarded(req, async (s) => {
      const out = await this.stalwart.call(s, "Mailbox/get", {
        properties: ["id", "name", "role", "parentId", "totalEmails", "unreadEmails"],
      });
      const list = Array.isArray(out.list) ? (out.list as Obj[]) : [];
      // отдаём браузеру только нужные поля
      return {
        mailboxes: list.map((m) => ({
          id: m.id, name: m.name, role: m.role ?? null, parentId: m.parentId ?? null,
          total: m.totalEmails ?? 0, unread: m.unreadEmails ?? 0,
        })),
      };
    });
  }

  @Get("emails")
  async emails(@Req() req: Request, @Query("mailbox") mailbox = "", @Query("position") position = "0", @Query("limit") limit = "30", @Query("q") q = "") {
    this.checkId(mailbox);
    const pos = Number(position), lim = Number(limit);
    if (!Number.isInteger(pos) || pos < 0 || pos > 100_000 || !Number.isInteger(lim) || lim < 1 || lim > 50) {
      throw new BadRequestException({ message: "Неверные параметры списка" });
    }
    const text = typeof q === "string" ? q.trim().slice(0, 200) : "";
    return this.guarded(req, async (s) => {
      const filter: Obj = { inMailbox: mailbox };
      if (text) filter.text = text;
      const [query, get] = await this.stalwart.batch(s, [
        ["Email/query", { filter, sort: [{ property: "receivedAt", isAscending: false }], position: pos, limit: lim, calculateTotal: true }],
        ["Email/get", { "#ids": { resultOf: "0", name: "Email/query", path: "/ids" }, properties: LIST_PROPS }],
      ]);
      const list = Array.isArray(get.list) ? (get.list as Obj[]) : [];
      return {
        total: num(query.total),
        position: pos,
        emails: list.map((m) => ({
          id: str(m.id, 200), from: addrs(m.from)[0] ?? null, to: addrs(m.to)[0] ?? null, subject: str(m.subject, 300),
          receivedAt: str(m.receivedAt, 40), preview: str(m.preview, 200), hasAttachment: m.hasAttachment === true,
          unread: !hasKw(m.keywords, "$seen"), draft: hasKw(m.keywords, "$draft"),
        })),
      };
    });
  }

  // Читает письмо и проверяет, что оно существует (общая часть для чтения и скачивания)
  private async loadEmail(s: SessionInfo, id: string): Promise<Obj> {
    const out = await this.stalwart.call(s, "Email/get", {
      ids: [id], properties: OPEN_PROPS, fetchTextBodyValues: true, fetchHTMLBodyValues: true, maxBodyValueBytes: MAX_BODY,
    });
    const m = Array.isArray(out.list) ? (out.list[0] as Obj | undefined) : undefined;
    if (!m) throw new StalwartError("notfound", "нет письма");
    return m;
  }

  @Get("emails/:id")
  async open(@Req() req: Request, @Param("id") id: string) {
    this.checkId(id);
    return this.guarded(req, async (s) => {
      const m = await this.loadEmail(s, id);
      const values = (m.bodyValues ?? {}) as Record<string, { value?: string; isTruncated?: boolean }>;
      const join = (parts: unknown, type: string) => {
        let text = "", truncated = false, found = false;
        for (const p of Array.isArray(parts) ? (parts as Part[]) : []) {
          if (p.type !== type || !p.partId) continue;
          const v = values[p.partId];
          if (!v || typeof v.value !== "string") continue;
          found = true;
          text += v.value;
          truncated ||= v.isTruncated === true;
        }
        return { text, truncated, found };
      };
      const plain = join(m.textBody, "text/plain");
      const html = join(m.htmlBody, "text/html");
      const topType = str(((m.bodyStructure ?? {}) as Part).type, 100).toLowerCase();
      const attachments = (Array.isArray(m.attachments) ? (m.attachments as Part[]) : []).filter((a) => a.blobId && ID_RE.test(a.blobId));
      return {
        id, unread: !hasKw(m.keywords, "$seen"), mailboxIds: Object.keys((m.mailboxIds ?? {}) as Obj),
        from: addrs(m.from)[0] ?? null, to: addrs(m.to), cc: addrs(m.cc), replyTo: addrs(m.replyTo),
        subject: str(m.subject, 300), receivedAt: str(m.receivedAt, 40), sentAt: str(m.sentAt, 40), size: num(m.size),
        text: plain.found ? plain.text : "", html: html.found ? html.text : "", truncated: plain.truncated || html.truncated,
        // зашифрованное письмо (S/MIME или PGP): на этом этапе показываем только плашку и даём скачать
        encrypted: /pkcs7-mime|multipart\/encrypted/.test(topType),
        attachments: attachments.map((a) => ({ blobId: a.blobId, name: fileName(str(a.name, 300), "вложение"), type: str(a.type, 100), size: num(a.size) })),
      };
    });
  }

  @Post("emails/:id/seen")
  @HttpCode(200)
  async seen(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    this.checkId(id);
    const seen = (body as Obj | null)?.seen;
    if (typeof seen !== "boolean") throw new BadRequestException({ message: "Нужно поле seen: true или false" });
    return this.guarded(req, async (s) => {
      // точечная правка одного флага; остальные пометки письма не затрагиваются
      const out = await this.stalwart.call(s, "Email/set", { update: { [id]: { "keywords/$seen": seen ? true : null } } });
      if (!out.updated || !(id in (out.updated as Obj))) throw new StalwartError("notfound", "нет письма");
      return { ok: true };
    });
  }

  // Удалить: письмо уходит в корзину; письмо, уже лежащее в корзине, удаляется насовсем
  @Post("emails/:id/trash")
  @HttpCode(200)
  async trash(@Req() req: Request, @Param("id") id: string) {
    this.checkId(id);
    return this.guarded(req, async (s) => {
      const [mail, boxes] = await this.stalwart.batch(s, [
        ["Email/get", { ids: [id], properties: ["mailboxIds"] }],
        ["Mailbox/get", { properties: ["id", "role"] }],
      ]);
      const m = Array.isArray(mail.list) ? (mail.list[0] as Obj | undefined) : undefined;
      if (!m) throw new StalwartError("notfound", "нет письма");
      const trashId = (Array.isArray(boxes.list) ? (boxes.list as Obj[]) : []).find((b) => b.role === "trash")?.id;
      if (typeof trashId !== "string") throw new StalwartError("protocol", "нет папки корзины");
      const inTrash = Object.keys((m.mailboxIds ?? {}) as Obj).includes(trashId);
      const out = await this.stalwart.call(
        s, "Email/set", inTrash ? { destroy: [id] } : { update: { [id]: { mailboxIds: { [trashId]: true } } } },
      );
      const done = inTrash ? Array.isArray(out.destroyed) && out.destroyed.includes(id) : !!out.updated && id in (out.updated as Obj);
      if (!done) throw new StalwartError("protocol", "не удалось удалить");
      return { ok: true, permanent: inTrash };
    });
  }

  // Потоковая выдача файла: всегда как скачивание, тип скрыт (octet-stream), браузер ничего не выполняет
  private async send(res: Response, up: globalThis.Response, name: string): Promise<void> {
    res.status(200);
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${asciiName(name)}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16))}`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'");
    const len = up.headers.get("content-length");
    if (len && /^\d+$/.test(len)) res.setHeader("Content-Length", len);
    const stream = Readable.fromWeb(up.body as never);
    stream.on("error", () => res.destroy());
    res.on("close", () => stream.destroy());
    stream.pipe(res);
  }

  @Get("emails/:id/attachments/:blobId")
  async attachment(@Req() req: Request, @Res() res: Response, @Param("id") id: string, @Param("blobId") blobId: string) {
    this.checkId(id); this.checkId(blobId);
    const prepared = await this.guarded(req, async (s) => {
      const m = await this.loadEmail(s, id);
      // отдаём только то, что действительно является вложением этого письма
      const a = (Array.isArray(m.attachments) ? (m.attachments as Part[]) : []).find((x) => x.blobId === blobId);
      if (!a) throw new StalwartError("notfound", "нет вложения");
      return { up: await this.stalwart.download(s, blobId), name: fileName(str(a.name, 300), "вложение") };
    });
    await this.send(res, prepared.up, prepared.name);
  }

  @Get("emails/:id/raw")
  async raw(@Req() req: Request, @Res() res: Response, @Param("id") id: string) {
    this.checkId(id);
    const up = await this.guarded(req, async (s) => {
      const m = await this.loadEmail(s, id);
      if (typeof m.blobId !== "string" || !ID_RE.test(m.blobId)) throw new StalwartError("notfound", "нет письма");
      return this.stalwart.download(s, m.blobId);
    });
    await this.send(res, up, "message.eml");
  }
}
