import { Injectable } from "@nestjs/common";
import type { ServerLimits } from "./stalwart.client";

// Общие правила для вложений (проверяются на сервере, страница лишь повторяет их для удобства)
export const MAX_FILE = 25 * 1024 * 1024;   // один файл
export const MAX_TOTAL = 25 * 1024 * 1024;  // все вложения одного письма вместе (как в Gmail)
export const MAX_FILES = 20;                // файлов в одном письме
export const UPLOADS_PER_HOUR = 100;        // загрузок в час с одной сессии
export const MAX_PARALLEL = 3;              // одновременных загрузок с одной сессии (файл держится в памяти целиком)

// Исполняемые и опасные типы по расширению (список Gmail плюс sh). Проверяется последнее расширение.
const BLOCKED_EXT = new Set([
  "ade", "adp", "apk", "appx", "bat", "cab", "chm", "cmd", "com", "cpl", "dll", "dmg", "ex", "ex_", "exe", "hta", "ins", "isp",
  "iso", "jar", "js", "jse", "lib", "lnk", "mde", "msc", "msi", "msix", "msp", "mst", "nsh", "pif", "ps1", "scr", "sct", "sh",
  "shb", "sys", "vb", "vbe", "vbs", "vxd", "wsc", "wsf", "wsh",
]);

// Управляющие знаки и знаки, запрещённые в именах файлов (пути, двоеточие, звёздочка и т.п.)
const CONTROL_AND_SEPARATORS = /[\u0000-\u001f\u007f\\/:*?"<>|]/g;
// Разделители строк и абзацев Юникода (U+2028, U+2029): собираем из кодов, чтобы они не были спрятаны в исходнике невидимыми символами
const LINE_SEPARATORS = new RegExp("[" + String.fromCharCode(0x2028, 0x2029) + "]", "g");

/** Безопасное имя файла: без путей и управляющих знаков, без точек и пробелов на конце, до 200 знаков */
export function safeName(raw: unknown, fallback = "файл"): string {
  const s = typeof raw === "string" ? raw : "";
  const clean = s.replace(CONTROL_AND_SEPARATORS, "_").replace(LINE_SEPARATORS, "_").replace(/^\.+/, "_").replace(/[ .]+$/, "").trim();
  return Array.from(clean).slice(0, 200).join("") || fallback;
}

/** Тип содержимого: только «тип/подтип» из безопасных знаков, иначе общий двоичный */
export function safeType(raw: unknown): string {
  const t = typeof raw === "string" ? raw.split(";")[0].trim().toLowerCase() : "";
  return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,60}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,100}$/.test(t) ? t : "application/octet-stream";
}

const extOf = (name: string): string => {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i + 1).toLowerCase();
};

/** Признаки исполняемых файлов по началу содержимого (на случай переименования): Windows PE, Linux ELF, macOS Mach-O, Java class */
function looksExecutable(b: Buffer): boolean {
  if (b.length >= 4 && b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46) return true; // ELF
  if (b.length >= 4) {
    const w = b.readUInt32BE(0);
    if (w === 0xfeedface || w === 0xfeedfacf || w === 0xcefaedfe || w === 0xcffaedfe || w === 0xcafebabe) return true; // Mach-O, Java
  }
  if (b.length >= 64 && b[0] === 0x4d && b[1] === 0x5a) { // MZ + указатель на заголовок PE
    const off = b.readUInt32LE(0x3c);
    if (off + 4 <= b.length && b[off] === 0x50 && b[off + 1] === 0x45 && b[off + 2] === 0 && b[off + 3] === 0) return true;
  }
  return false;
}

/** Причина отказа или null, если файл можно прикладывать */
export function blockedReason(name: string, body: Buffer | null): string | null {
  const ext = extOf(name);
  if (BLOCKED_EXT.has(ext)) return `Файлы типа .${ext} нельзя отправлять: они могут содержать программу.`;
  if (body && looksExecutable(body)) return "Похоже на программу (исполняемый файл), такие файлы нельзя отправлять.";
  return null;
}

/** Действующие пределы: наши, но не больше того, что объявляет Stalwart */
export function effectiveLimits(sl: ServerLimits): { file: number; total: number; count: number } {
  return {
    file: Math.min(MAX_FILE, sl.maxUpload ?? Infinity),
    total: Math.min(MAX_TOTAL, sl.maxAttachments ?? Infinity),
    count: MAX_FILES,
  };
}

export const megabytes = (n: number): string => `${(n / 1024 / 1024).toFixed(n % (1024 * 1024) === 0 ? 0 : 1).replace(".", ",")} МБ`;

export interface Att { name: string; type: string; size: number; at: number }

// Что пользователь уже загрузил для писем в текущей сессии. Письмо можно собрать только из этих файлов:
// чужой или выдуманный идентификатор файла не принимается. Всё хранится в памяти и исчезает при перезапуске.
@Injectable()
export class AttachmentRegistry {
  private readonly map = new Map<string, Map<string, Att>>();
  private readonly sends = new Map<string, number[]>();
  private readonly busy = new Map<string, number>();
  private static readonly TTL = 6 * 3_600_000;

  private bucket(token: string): Map<string, Att> {
    let b = this.map.get(token);
    if (!b) {
      this.prune();
      b = new Map();
      this.map.set(token, b);
    }
    return b;
  }

  private prune(now = Date.now()): void {
    for (const [t, b] of this.map) {
      for (const [id, a] of b) if (now - a.at > AttachmentRegistry.TTL) b.delete(id);
      if (b.size === 0) this.map.delete(t);
    }
    if (this.map.size > 2000) this.map.clear(); // защита от разрастания памяти
  }

  list(token: string): Map<string, Att> { return this.map.get(token) ?? new Map(); }
  total(token: string): number { let n = 0; for (const a of this.list(token).values()) n += a.size; return n; }
  add(token: string, id: string, a: Omit<Att, "at">): void { this.bucket(token).set(id, { ...a, at: Date.now() }); }
  remove(token: string, ids: string[]): void { const b = this.map.get(token); if (b) for (const id of ids) b.delete(id); }

  /** Сколько секунд ждать до следующей загрузки (0 = можно) и учёт новой */
  limit(token: string, now = Date.now()): number {
    const hour = 3_600_000;
    const list = (this.sends.get(token) ?? []).filter((t) => now - t < hour);
    if (list.length >= UPLOADS_PER_HOUR) { this.sends.set(token, list); return Math.ceil((list[0] + hour - now) / 1000); }
    list.push(now);
    this.sends.set(token, list);
    if (this.sends.size > 5000) for (const [k, v] of this.sends) if (!v.some((t) => now - t < hour)) this.sends.delete(k);
    return 0;
  }

  /** Одновременные загрузки: занять место (false, если уже слишком много) и освободить */
  acquire(token: string): boolean {
    const n = this.busy.get(token) ?? 0;
    if (n >= MAX_PARALLEL) return false;
    this.busy.set(token, n + 1);
    return true;
  }
  release(token: string): void {
    const n = (this.busy.get(token) ?? 1) - 1;
    if (n <= 0) this.busy.delete(token); else this.busy.set(token, n);
  }
}
