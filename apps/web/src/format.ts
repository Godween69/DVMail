// Мелкие помощники показа: даты, имена, размеры, названия папок.
import type { Addr, Mailbox } from "./api";

const timeFmt = new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" });
const dayFmt = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short" });
const yearFmt = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", year: "numeric" });
const fullFmt = new Intl.DateTimeFormat("ru-RU", { weekday: "short", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" });

const parse = (iso: string): Date | null => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? null : d; };

/** В списке: сегодня время, в этом году день и месяц, раньше с годом */
export function listDate(iso: string, now = new Date()): string {
  const d = parse(iso);
  if (!d) return "";
  if (d.toDateString() === now.toDateString()) return timeFmt.format(d);
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return "вчера";
  return (d.getFullYear() === now.getFullYear() ? dayFmt : yearFmt).format(d).replace(/\s?г\.$/, "");
}
export const fullDate = (iso: string): string => { const d = parse(iso); return d ? fullFmt.format(d) : ""; };

/** Имя для показа: имя отправителя, иначе адрес */
export const who = (a: Addr | null | undefined): string => (a ? a.name?.trim() || a.email : "—");

/** Буква в аватарке */
export function initial(a: Addr | null | undefined): string {
  const s = (a?.name?.trim() || a?.email || "?").replace(/^[^\p{L}\p{N}]+/u, "");
  return (s.charAt(0) || "?").toUpperCase();
}

/** Один из шести оттенков аватарки: одинаковый адрес даёт одинаковый цвет */
export function tone(seed: string): number {
  let n = 0;
  for (const ch of seed.toLowerCase()) n = (n * 31 + ch.charCodeAt(0)) % 6;
  return n;
}

export function fileSize(n: number): string {
  if (n < 1024) return `${n} Б`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} КБ`;
  return `${(n / 1024 / 1024).toFixed(1).replace(".", ",")} МБ`;
}

// Названия папок по ролям, которые присылает сам сервер (названия у него английские)
const LABELS: Record<string, string> = {
  inbox: "Входящие", drafts: "Черновики", sent: "Отправленные", archive: "Архив", junk: "Спам", trash: "Корзина",
};
const ORDER = ["inbox", "drafts", "sent", "archive", "junk", "trash"];
export const folderLabel = (m: Mailbox): string => (m.role && LABELS[m.role]) || m.name;
export function sortMailboxes(list: Mailbox[]): Mailbox[] {
  const rank = (m: Mailbox) => { const i = m.role ? ORDER.indexOf(m.role) : -1; return i < 0 ? ORDER.length : i; };
  return [...list].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, "ru"));
}
