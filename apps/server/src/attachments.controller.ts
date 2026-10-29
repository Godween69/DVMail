import { BadRequestException, Controller, Delete, Get, HttpCode, HttpException, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { AttachmentRegistry, blockedReason, effectiveLimits, MAX_FILES, megabytes, safeName, safeType } from "./attachments";
import { runGuarded } from "./guarded";
import { SessionGuard } from "./session.guard";
import { SessionStore } from "./session.store";
import { ID_RE, StalwartClient, StalwartError } from "./stalwart.client";
import type { SessionInfo, SessionRequest } from "./types";

const bad = (message: string) => new BadRequestException({ message });

// Загрузка файлов для вложений. Файл приходит «как есть» в теле запроса (без оформления формы), имя в адресе.
// Тело разбирается в bootstrap.ts после предварительной проверки сессии и размера, здесь мы получаем готовый Buffer.
@Controller("api")
@UseGuards(SessionGuard)
export class AttachmentsController {
  constructor(
    private readonly stalwart: StalwartClient,
    private readonly store: SessionStore,
    private readonly reg: AttachmentRegistry,
  ) {}

  private guarded<T>(req: Request, fn: (s: SessionInfo) => Promise<T>): Promise<T> {
    return runGuarded(this.store, req, fn);
  }

  /** Пределы для страницы: размер файла, общий размер, число файлов */
  @Get("limits")
  async limits(@Req() req: Request) {
    return this.guarded(req, async (s) => effectiveLimits(await this.stalwart.limits(s)));
  }

  @Post("attachments")
  @HttpCode(200)
  async upload(@Req() req: Request, @Query("name") nameRaw: unknown) {
    const token = (req as SessionRequest).dvToken;
    const body = req.body as unknown;
    if (!Buffer.isBuffer(body) || body.length === 0) throw bad("Файл пустой");
    const name = safeName(typeof nameRaw === "string" ? nameRaw.slice(0, 600) : "");
    const type = safeType(req.headers["content-type"]);

    const reason = blockedReason(name, body);
    if (reason) throw bad(reason);

    return this.guarded(req, async (s) => {
      const lim = effectiveLimits(await this.stalwart.limits(s));
      if (body.length > lim.file) throw new HttpException({ message: `Файл больше ${megabytes(lim.file)}` }, 413);
      if (this.reg.list(token).size >= MAX_FILES) throw bad(`Не больше ${MAX_FILES} файлов в письме`);
      if (this.reg.total(token) + body.length > lim.total) throw bad(`Вложения не больше ${megabytes(lim.total)} в сумме`);
      const wait = this.reg.limit(token);
      if (wait > 0) throw new HttpException({ message: "Слишком много загрузок за час. Попробуйте позже." }, 429);

      let up: { blobId: string; size: number };
      try {
        up = await this.stalwart.upload(s, type, body);
      } catch (e) {
        if (e instanceof StalwartError && e.kind === "toolarge") throw new HttpException({ message: "Почтовый сервер не принимает файл такого размера" }, 413);
        throw e;
      }
      this.reg.add(token, up.blobId, { name, type, size: body.length });
      return { blobId: up.blobId, name, type, size: body.length };
    });
  }

  /** Убрать файл из письма (сам файл в Stalwart удалится по его сроку хранения) */
  @Delete("attachments/:blobId")
  @HttpCode(200)
  remove(@Req() req: Request, @Param("blobId") blobId: string) {
    if (!ID_RE.test(blobId)) throw bad("Неверный идентификатор файла");
    this.reg.remove((req as SessionRequest).dvToken, [blobId]);
    return { ok: true };
  }
}
