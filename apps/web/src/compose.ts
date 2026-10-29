// Подготовка нового письма: ответ, ответ всем, пересылка. Чистые функции без обращения к сети (их можно проверять тестами).
import type { Addr, EmailFull } from "./api";
import { fullDate, who } from "./format";

export type ComposeMode = "new" | "reply" | "replyAll" | "forward";

export interface Draft {
  mode: ComposeMode;
  replyTo: string | null; // id письма, на которое отвечаем (сервер сам возьмёт из него заголовки цепочки)
  to: string; cc: string; bcc: string; // адреса через запятую, как их видит пользователь
  subject: string; text: string;
}

export const emptyDraft = (): Draft => ({ mode: "new", replyTo: null, to: "", cc: "", bcc: "", subject: "", text: "" });

// Такой же строгий вид адреса, как на сервере (сервер проверяет всё равно сам)
export const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;

/** Разбор строки адресов: понимает «Имя <адрес>», адреса через запятую, точку с запятой, пробел и перевод строки */
export function parseAddresses(input: string): { ok: string[]; bad: string[] } {
  const found: string[] = [];
  // сначала вынимаем «Имя <адрес>» (в имени может быть запятая), остаток разбираем по разделителям
  const rest = input.replace(/[^,;<>]*<([^<>]*)>/g, (_m, addr: string) => { found.push(addr.trim()); return " "; });
  for (const t of rest.split(/[\s,;]+/)) if (t) found.push(t.replace(/^"+|"+$/g, ""));
  const ok: string[] = [], bad: string[] = [], seen = new Set<string>();
  for (const a of found) {
    if (!EMAIL_RE.test(a) || a.length > 254) { bad.push(a); continue; }
    const k = a.toLowerCase();
    if (!seen.has(k)) { seen.add(k); ok.push(a); }
  }
  return { ok, bad };
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const join = (list: string[]) => list.join(", ");
const uniq = (list: string[]) => list.filter((a, i) => list.findIndex((b) => same(a, b)) === i);

const withPrefix = (subject: string, re: RegExp, prefix: string) => (re.test(subject) ? subject : `${prefix}${subject}`.trim());

/** Текст письма для цитаты: обычный текст, а если его нет, то текст из HTML (без выполнения чего-либо) */
export function plainOf(m: Pick<EmailFull, "text" | "html" | "encrypted">): string {
  if (m.encrypted) return "";
  if (m.text.trim()) return m.text;
  if (m.html.trim() && typeof DOMParser !== "undefined") {
    const doc = new DOMParser().parseFromString(m.html, "text/html");
    doc.querySelectorAll("script,style,head").forEach((n) => n.remove());
    return (doc.body.textContent ?? "").replace(/\n{3,}/g, "\n\n").trim();
  }
  return "";
}

const quote = (text: string) => text.replace(/\r\n?/g, "\n").trimEnd().split("\n").map((l) => (l.startsWith(">") ? ">" + l : "> " + l)).join("\n");
const line = (a: Addr | null) => (a ? (a.name ? `${a.name} <${a.email}>` : a.email) : "—");
const addrList = (l: Addr[]) => l.map((a) => a.email);

/** Черновик ответа, ответа всем или пересылки. own: все адреса самого пользователя (их не добавляем в получатели) */
export function buildDraft(mode: Exclude<ComposeMode, "new">, m: EmailFull, own: string[]): Draft {
  const mine = (e: string) => own.some((o) => same(o, e));
  const body = plainOf(m);
  if (mode === "forward") {
    const head = [
      "---------- Пересылаемое письмо ----------",
      `От: ${line(m.from)}`, `Дата: ${fullDate(m.receivedAt)}`, `Тема: ${m.subject || "(без темы)"}`,
      `Кому: ${m.to.map((a) => line(a)).join(", ") || "—"}`,
      ...(m.cc.length ? [`Копия: ${m.cc.map((a) => line(a)).join(", ")}`] : []),
    ].join("\n");
    return { mode, replyTo: null, to: "", cc: "", bcc: "", subject: withPrefix(m.subject, /^(fwd?|пересл)\s*:/i, "Fwd: "), text: `\n\n${head}\n\n${body}` };
  }
  const target = (m.replyTo[0] ?? m.from)?.email ?? "";
  const quoted = `\n\n${fullDate(m.receivedAt)}, ${who(m.from)} ${m.from?.name ? `<${m.from.email}> ` : ""}написал(а):\n${quote(body)}`;
  const base = { replyTo: m.id, bcc: "", subject: withPrefix(m.subject, /^(re|ответ)\s*:/i, "Re: "), text: quoted };
  if (mode === "reply") return { ...base, mode, to: target, cc: "" };
  const to = uniq([target, ...addrList(m.to)].filter((e) => e && (!mine(e) || same(e, target))));
  const cc = uniq(addrList(m.cc).filter((e) => !mine(e) && !to.some((t) => same(t, e))));
  return { ...base, mode, to: join(to), cc: join(cc) };
}

/** Есть ли в письме то, что жалко потерять при закрытии окна */
export const isDirty = (d: Draft, start: Draft): boolean =>
  d.to !== start.to || d.cc !== start.cc || d.bcc !== start.bcc || d.subject !== start.subject || d.text !== start.text;
