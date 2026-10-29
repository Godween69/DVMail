import { Controller, Get, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { runGuarded } from "./guarded";
import { EMAIL_RE } from "./send.controller";
import { SessionGuard } from "./session.guard";
import { SessionStore } from "./session.store";
import { ID_RE, JmapCall, StalwartClient } from "./stalwart.client";
import type { SessionInfo, SessionRequest } from "./types";

type Obj = Record<string, unknown>;
export interface Contact { name: string; email: string }

// Подсказки адресов строятся из самой почты ящика: нигде отдельно не хранятся, при выходе или перезапуске исчезают.
const PER_BOX = 250;          // сколько последних писем смотрим в «Отправленных» и во «Входящих»
const MAX_CONTACTS = 500;     // сколько адресов отдаём браузеру (он сам отбирает по набранным буквам)
const TTL_MS = 60_000;        // список запоминается на минуту: быстро открыть окно письма несколько раз подряд
const WEEK_MS = 7 * 24 * 3_600_000;
const AUTO_RE = /(^|[._+-])(no-?reply|do-?not-?reply|mailer-daemon|postmaster|bounces?|notifications?)([._+-]|@)/i; // автоматические отправители не нужны

// Одна строка, без управляющих знаков и разделителей строк; знаки, ломающие запись «Имя <адрес>», убираем
const cleanName = (v: unknown): string =>
  typeof v === "string"
    ? v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(new RegExp("[" + String.fromCharCode(0x2028, 0x2029) + "]", "g"), " ").replace(/[<>",;]/g, "").replace(/\s+/g, " ").trim().slice(0, 100)
    : "";

interface Agg { email: string; name: string; sent: number; recv: number; last: number }

@Controller("api")
@UseGuards(SessionGuard)
export class ContactsController {
  private readonly cache = new Map<string, { at: number; list: Contact[] }>();

  constructor(private readonly stalwart: StalwartClient, private readonly store: SessionStore) {}

  /** Список адресов для подсказок в окне письма: самые нужные сверху (кому писали чаще и недавно, потом от кого получали) */
  @Get("contacts")
  async contacts(@Req() req: Request) {
    const token = (req as SessionRequest).dvToken;
    return runGuarded(this.store, req, async (s: SessionInfo) => {
      const hit = this.cache.get(token);
      if (hit && Date.now() - hit.at < TTL_MS) return { contacts: hit.list };
      const list = await this.build(s);
      if (this.cache.size > 500) this.cache.clear(); // защита от разрастания памяти
      this.cache.set(token, { at: Date.now(), list });
      return { contacts: list };
    });
  }

  private async build(s: SessionInfo): Promise<Contact[]> {
    const [idents, boxes] = await this.stalwart.batch(s, [
      ["Identity/get", { properties: ["email"] }],
      ["Mailbox/get", { properties: ["id", "role"] }],
    ]);
    const own = new Set<string>([s.email.toLowerCase()]);
    for (const i of Array.isArray(idents.list) ? (idents.list as Obj[]) : []) if (typeof i.email === "string") own.add(i.email.toLowerCase());
    const roleId = (role: string): string | null => {
      const id = (Array.isArray(boxes.list) ? (boxes.list as Obj[]) : []).find((m) => m.role === role)?.id;
      return typeof id === "string" && ID_RE.test(id) ? id : null;
    };
    const sent = roleId("sent"), inbox = roleId("inbox");

    const calls: JmapCall[] = [];
    const add = (box: string, props: string[]) => {
      const n = calls.length;
      calls.push(["Email/query", { filter: { inMailbox: box }, sort: [{ property: "receivedAt", isAscending: false }], position: 0, limit: PER_BOX }]);
      calls.push(["Email/get", { "#ids": { resultOf: String(n), name: "Email/query", path: "/ids" }, properties: props }]);
      return n + 1;
    };
    const sentAt = sent ? add(sent, ["to", "cc", "receivedAt"]) : -1;
    const inboxAt = inbox ? add(inbox, ["from", "receivedAt"]) : -1;
    if (calls.length === 0) return [];
    const res = await this.stalwart.batch(s, calls);

    const map = new Map<string, Agg>();
    const touch = (a: unknown, kind: "sent" | "recv", when: number) => {
      const o = (a ?? {}) as Obj;
      const email = typeof o.email === "string" ? o.email.trim() : "";
      const key = email.toLowerCase();
      if (!EMAIL_RE.test(email) || email.length > 254 || own.has(key)) return;
      if (kind === "recv" && AUTO_RE.test(key)) return;
      const x = map.get(key) ?? { email, name: "", sent: 0, recv: 0, last: 0 };
      x[kind]++;
      const name = cleanName(o.name);
      if (name && name.toLowerCase() !== key && when >= x.last) x.name = name; // имя берём из самого свежего письма, где оно есть
      if (when > x.last) x.last = when;
      map.set(key, x);
    };
    const mails = (at: number): Obj[] => (at >= 0 && Array.isArray(res[at]?.list) ? (res[at].list as Obj[]) : []);
    const time = (m: Obj) => { const t = Date.parse(typeof m.receivedAt === "string" ? m.receivedAt : ""); return Number.isFinite(t) ? t : 0; };
    for (const m of mails(sentAt)) for (const f of ["to", "cc"]) for (const a of Array.isArray(m[f]) ? (m[f] as unknown[]).slice(0, 50) : []) touch(a, "sent", time(m));
    for (const m of mails(inboxAt)) for (const a of Array.isArray(m.from) ? (m.from as unknown[]).slice(0, 5) : []) touch(a, "recv", time(m));

    const newest = Math.max(0, ...[...map.values()].map((x) => x.last));
    const score = (x: Agg) => x.sent * 3 + x.recv + (newest - x.last < WEEK_MS ? 2 : 0);
    return [...map.values()]
      .sort((a, b) => score(b) - score(a) || b.last - a.last || a.email.localeCompare(b.email))
      .slice(0, MAX_CONTACTS)
      .map((x) => ({ name: x.name, email: x.email }));
  }
}
