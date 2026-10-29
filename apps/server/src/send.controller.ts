import { BadRequestException, Body, Controller, Get, HttpCode, HttpException, Post, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { AttachmentRegistry, effectiveLimits, MAX_FILES, megabytes, safeName, safeType } from "./attachments";
import { runGuarded } from "./guarded";
import { SessionGuard } from "./session.guard";
import { SessionStore } from "./session.store";
import { ID_RE, StalwartClient, StalwartError } from "./stalwart.client";
import type { SessionInfo, SessionRequest } from "./types";

type Obj = Record<string, unknown>;
interface Identity { id: string; name: string; email: string }

// Предельные значения: всё лишнее отклоняется до обращения к Stalwart
const MAX_RECIPIENTS = 50;       // адресов в сумме (кому, копия, скрытая копия)
const MAX_SUBJECT = 300;
const MAX_TEXT = 100_000;        // знаков в тексте письма
const MAX_REFS = 20;             // длина цепочки «на какие письма это ответ»
const SENDS_PER_HOUR = 40;       // писем в час с одного ящика (защита, если чужой получит доступ к сессии)

// Простой и строгий вид адреса: без пробелов, скобок, кавычек и управляющих знаков (никаких вставок в заголовки)
const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;

const bad = (message: string) => new BadRequestException({ message });
const oneLine = (v: unknown, max: number): string =>
  typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").trim().slice(0, max) : "";

function recipients(v: unknown, label: string): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > MAX_RECIPIENTS) throw bad(`Слишком много адресов в поле «${label}»`);
  return v.map((x) => {
    const e = typeof x === "string" ? x.trim() : "";
    if (!EMAIL_RE.test(e) || e.length > 254) throw bad(`Неверный адрес в поле «${label}»: ${oneLine(x, 80) || "пусто"}`);
    return e;
  });
}

// Сообщения об отказах отправки (типы взяты из RFC 8621)
const SUBMIT_ERRORS: Record<string, string> = {
  forbiddenFrom: "Сервер не разрешает отправлять с этого адреса",
  forbiddenMailFrom: "Сервер не разрешает отправлять с этого адреса",
  forbiddenToSend: "Отправка писем с этого ящика сейчас запрещена",
  invalidEmail: "Сервер не принял письмо: проверьте адреса получателей",
  noRecipients: "Не указан ни один получатель",
  tooManyRecipients: "Слишком много получателей",
  overQuota: "Нет места в ящике для копии письма",
};

@Controller("api")
@UseGuards(SessionGuard)
export class SendController {
  private readonly sends = new Map<string, number[]>();

  constructor(private readonly stalwart: StalwartClient, private readonly store: SessionStore, private readonly files: AttachmentRegistry) {}

  private guarded<T>(req: Request, fn: (s: SessionInfo) => Promise<T>): Promise<T> {
    return runGuarded(this.store, req, fn);
  }

  /** Сколько секунд ждать до следующей отправки (0 = можно) и учёт новой */
  private limit(email: string, now = Date.now()): number {
    const hour = 3_600_000;
    const list = (this.sends.get(email) ?? []).filter((t) => now - t < hour);
    if (list.length >= SENDS_PER_HOUR) { this.sends.set(email, list); return Math.ceil((list[0] + hour - now) / 1000); }
    list.push(now);
    this.sends.set(email, list);
    if (this.sends.size > 5000) for (const [k, v] of this.sends) if (!v.some((t) => now - t < hour)) this.sends.delete(k);
    return 0;
  }

  @Get("identities")
  async identities(@Req() req: Request) {
    return this.guarded(req, async (s) => ({ identities: await this.readIdentities(s) }));
  }

  private async readIdentities(s: SessionInfo): Promise<Identity[]> {
    const out = await this.stalwart.call(s, "Identity/get", { properties: ["id", "name", "email"] });
    const list = Array.isArray(out.list) ? (out.list as Obj[]) : [];
    return list
      .filter((i) => typeof i.id === "string" && ID_RE.test(i.id) && typeof i.email === "string" && EMAIL_RE.test(i.email))
      .slice(0, 20)
      .map((i) => ({ id: i.id as string, name: oneLine(i.name, 200), email: i.email as string }));
  }

  /**
   * Отправка письма. Порядок действий (каждый шаг проверяется):
   * 1) читаем адреса отправителя, папки и (для ответа) заголовки исходного письма;
   * 2) создаём письмо в «Черновиках»; 3) отправляем; 4) переносим копию в «Отправленные».
   * Адрес «От кого» берётся только из адресов самого ящика на сервере, браузер его не задаёт.
   */
  @Post("send")
  @HttpCode(200)
  async send(@Req() req: Request, @Body() body: unknown) {
    const b = (body && typeof body === "object" ? body : {}) as Obj;
    const identityId = typeof b.identityId === "string" && ID_RE.test(b.identityId) ? b.identityId : "";
    if (!identityId) throw bad("Не выбран адрес отправителя");
    const to = recipients(b.to, "Кому"), cc = recipients(b.cc, "Копия"), bcc = recipients(b.bcc, "Скрытая копия");
    // без повторов (адреса без учёта регистра), порядок и написание берём по первому упоминанию
    const seen = new Set<string>();
    const all = [...to, ...cc, ...bcc].filter((e) => { const k = e.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
    if (all.length === 0) throw bad("Укажите хотя бы одного получателя");
    if (to.length + cc.length + bcc.length > MAX_RECIPIENTS) throw bad("Слишком много получателей");
    if (b.subject !== undefined && typeof b.subject !== "string") throw bad("Неверная тема");
    if (b.text !== undefined && typeof b.text !== "string") throw bad("Неверный текст письма");
    const subject = oneLine(b.subject, MAX_SUBJECT);
    const rawText = typeof b.text === "string" ? b.text : "";
    if (rawText.length > MAX_TEXT) throw bad("Письмо слишком большое: до 100 000 знаков (вложения пока не поддерживаются)");
    // нормализуем переводы строк, убираем управляющие знаки кроме перевода строки и табуляции
    const text = rawText.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
    const replyTo = b.replyTo === undefined || b.replyTo === null ? null : typeof b.replyTo === "string" && ID_RE.test(b.replyTo) ? b.replyTo : "";
    if (replyTo === "") throw bad("Неверный идентификатор письма, на которое отвечаете");

    // вложения: загруженные в этой сессии файлы и (для пересылки) вложения исходного письма
    const ids = (v: unknown, label: string): string[] => {
      if (v === undefined || v === null) return [];
      if (!Array.isArray(v) || v.length > MAX_FILES || v.some((x) => typeof x !== "string" || !ID_RE.test(x))) throw bad(`Неверный список файлов (${label})`);
      return [...new Set(v as string[])];
    };
    const uploaded = ids(b.attachments, "вложения"), keep = ids(b.keep, "пересылаемые");
    const forwardOf = b.forwardOf === undefined || b.forwardOf === null ? null : typeof b.forwardOf === "string" && ID_RE.test(b.forwardOf) ? b.forwardOf : "";
    if (forwardOf === "") throw bad("Неверный идентификатор пересылаемого письма");
    if (keep.length > 0 && !forwardOf) throw bad("Пересылаемые вложения без письма");
    if (uploaded.length + keep.length > MAX_FILES) throw bad(`Не больше ${MAX_FILES} файлов в письме`);
    const token = (req as SessionRequest).dvToken;
    const mine = this.files.list(token);
    if (uploaded.some((id) => !mine.has(id))) throw bad("Один из файлов потерялся (сессия обновилась). Прикрепите его заново.");

    return this.guarded(req, async (s) => {
      const wait = this.limit(s.email);
      if (wait > 0) throw new HttpException({ message: `Лимит отправки: не больше ${SENDS_PER_HOUR} писем в час. Попробуйте позже.` }, 429);

      // 1. Что нужно знать до создания письма
      const calls: [string, Obj][] = [
        ["Identity/get", { properties: ["id", "name", "email"] }],
        ["Mailbox/get", { properties: ["id", "role"] }],
      ];
      if (replyTo) calls.push(["Email/get", { ids: [replyTo], properties: ["messageId", "inReplyTo", "references"] }]);
      if (forwardOf && keep.length) calls.push(["Email/get", { ids: [forwardOf], properties: ["attachments"] }]);
      const res = await this.stalwart.batch(s, calls);
      const [idsRes, boxes] = res;
      let at = 2;
      const orig = replyTo ? res[at++] : undefined;
      const fwd = forwardOf && keep.length ? res[at++] : undefined;
      const identity = (Array.isArray(idsRes.list) ? (idsRes.list as Obj[]) : []).find((i) => i.id === identityId);
      if (!identity || typeof identity.email !== "string" || !EMAIL_RE.test(identity.email)) throw bad("Этот адрес отправителя недоступен");
      const roleId = (role: string) => {
        const id = (Array.isArray(boxes.list) ? (boxes.list as Obj[]) : []).find((m) => m.role === role)?.id;
        return typeof id === "string" && ID_RE.test(id) ? id : null;
      };
      const drafts = roleId("drafts"), sent = roleId("sent");
      if (!drafts || !sent) throw new HttpException({ message: "В ящике нет папок «Черновики» или «Отправленные»" }, 502);

      // цепочка ответа: id исходного письма и его предшественники (без угловых скобок, как в JMAP)
      const msgIds = (v: unknown) => (Array.isArray(v) ? (v as unknown[]).filter((x): x is string => typeof x === "string" && x.length < 300 && !/[\s<>\u0000-\u001f]/.test(x)) : []);
      const origMail = replyTo && Array.isArray(orig?.list) ? ((orig.list as Obj[])[0] as Obj | undefined) : undefined;
      if (replyTo && !origMail) throw bad("Исходное письмо не найдено");
      const inReplyTo = origMail ? msgIds(origMail.messageId).slice(0, 1) : [];
      const references = origMail ? [...msgIds(origMail.references ?? origMail.inReplyTo), ...inReplyTo].slice(-MAX_REFS) : [];

      // вложения: свои загруженные файлы и (для пересылки) вложения исходного письма, найденные у самого письма
      const parts: { blobId: string; type: string; name: string; size: number }[] = uploaded.map((id) => {
        const a = mine.get(id)!;
        return { blobId: id, type: a.type, name: a.name, size: a.size };
      });
      if (keep.length) {
        const m = (Array.isArray(fwd?.list) ? ((fwd!.list as Obj[])[0] as Obj | undefined) : undefined);
        const have = (Array.isArray(m?.attachments) ? (m!.attachments as Obj[]) : []).filter((a) => typeof a.blobId === "string" && ID_RE.test(a.blobId));
        for (const id of keep) {
          const a = have.find((x) => x.blobId === id);
          if (!a) throw bad("Вложение пересылаемого письма не найдено");
          parts.push({ blobId: id, type: safeType(a.type), name: safeName(a.name, "вложение"), size: typeof a.size === "number" ? a.size : 0 });
        }
      }
      if (parts.length) {
        const lim = effectiveLimits(await this.stalwart.limits(s));
        const sum = parts.reduce((n, a) => n + a.size, 0);
        if (sum > lim.total) throw bad(`Вложения не больше ${megabytes(lim.total)} в сумме`);
      }

      // 2. Черновик (пометка «прочитано», чтобы счётчик непрочитанных не менялся)
      const draft: Obj = {
        mailboxIds: { [drafts]: true },
        keywords: { $draft: true, $seen: true },
        from: [{ name: oneLine(identity.name, 200) || null, email: identity.email }],
        to: to.map((email) => ({ email })),
        subject,
        textBody: [{ partId: "1", type: "text/plain" }],
        bodyValues: { 1: { value: text } },
      };
      if (parts.length) draft.attachments = parts.map((a) => ({ blobId: a.blobId, type: a.type, name: a.name, disposition: "attachment" }));
      if (cc.length) draft.cc = cc.map((email) => ({ email }));
      if (bcc.length) draft.bcc = bcc.map((email) => ({ email }));
      if (inReplyTo.length) draft.inReplyTo = inReplyTo;
      if (references.length) draft.references = references;
      const made = await this.stalwart.call(s, "Email/set", { create: { d1: draft } });
      const createdId = ((made.created as Obj | undefined)?.d1 as Obj | undefined)?.id;
      if (typeof createdId !== "string" || !ID_RE.test(createdId)) {
        throw new HttpException({ message: "Сервер не принял письмо. Проверьте тему, текст и адреса." }, 422);
      }
      const dropDraft = async () => { try { await this.stalwart.call(s, "Email/set", { destroy: [createdId] }); } catch { /* уже ничего не сделать */ } };

      // 3. Отправка: получатели заданы явно (так скрытая копия точно доходит)
      let submitted: Record<string, unknown>;
      try {
        submitted = await this.stalwart.call(s, "EmailSubmission/set", {
          create: {
            s1: {
              identityId, emailId: createdId,
              envelope: { mailFrom: { email: identity.email, parameters: null }, rcptTo: all.map((email) => ({ email, parameters: null })) },
            },
          },
        });
      } catch (e) { await dropDraft(); throw e; }
      if (!(submitted.created && typeof submitted.created === "object" && "s1" in (submitted.created as Obj))) {
        await dropDraft();
        const type = (((submitted.notCreated as Obj | undefined)?.s1 as Obj | undefined)?.type as string | undefined) ?? "";
        throw new HttpException({ message: SUBMIT_ERRORS[type] ?? "Сервер отказался отправлять письмо" }, 422);
      }

      // 4. Копия в «Отправленные». Письмо уже ушло, поэтому сбой здесь не считается ошибкой отправки
      let filed = true;
      try {
        const moved = await this.stalwart.call(s, "Email/set", {
          update: { [createdId]: { [`mailboxIds/${drafts}`]: null, [`mailboxIds/${sent}`]: true, "keywords/$draft": null } },
        });
        filed = !!moved.updated && createdId in (moved.updated as Obj);
      } catch (e) {
        if (e instanceof StalwartError && e.kind === "auth") throw e;
        filed = false;
      }
      this.files.remove(token, uploaded); // файлы ушли с письмом, из списка загруженных убираем
      return { ok: true, filed };
    });
  }
}
