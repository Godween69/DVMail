import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, Inject, Param, Post, UseGuards } from "@nestjs/common";
import { AdminConfig, CONFIG } from "./config";
import { SessionGuard } from "./session.guard";
import { StalwartAdmin } from "./stalwart-admin.client";

const NAME_RE = /^[a-z0-9][a-z0-9._-]{1,30}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,32}$/;

@Controller("api/accounts")
@UseGuards(SessionGuard)
export class AccountsController {
  constructor(private readonly stalwart: StalwartAdmin, @Inject(CONFIG) private readonly cfg: AdminConfig) {}

  @Get()
  async list() {
    return { domain: this.cfg.domain, accounts: await this.stalwart.list() };
  }

  @Post()
  @HttpCode(201)
  async create(@Body() body: unknown) {
    const b = (body ?? {}) as Record<string, unknown>;
    const name = typeof b.name === "string" ? b.name.trim().toLowerCase() : "";
    if (!NAME_RE.test(name)) {
      throw new BadRequestException({ message: "Имя: 2-31 символ, маленькие латинские буквы, цифры, точка, дефис, подчёркивание" });
    }
    if (this.cfg.reservedNames.includes(name)) throw new BadRequestException({ message: "Это имя зарезервировано" });
    // описание: только печатные символы, не длиннее 100
    const description = typeof b.description === "string"
      ? b.description.normalize("NFC").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 100)
      : "";
    if ((await this.stalwart.list()).some((a) => a.name === name)) {
      throw new ConflictException({ message: "Ящик с таким именем уже есть" });
    }
    return this.stalwart.create(name, description || null);
  }

  // Удаление через POST: так работает та же защита от подделки запросов, что и для остальных изменений
  @Post(":id/delete")
  @HttpCode(200)
  async remove(@Param("id") id: string, @Body() body: unknown) {
    if (!ID_RE.test(id)) throw new BadRequestException({ message: "Неверный Id" });
    const confirm = (body as Record<string, unknown> | null)?.confirmName;
    if (typeof confirm !== "string" || !confirm) throw new BadRequestException({ message: "Нужно имя для подтверждения" });
    await this.stalwart.destroy(id, confirm);
    return { ok: true };
  }
}
