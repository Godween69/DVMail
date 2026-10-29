// Правила вложений на странице. Сервер проверяет всё сам (это главное), здесь те же проверки для удобства:
// человек сразу видит, почему файл не прикрепился, и не ждёт загрузки напрасно. Чистые функции, их проверяют тесты.
import type { Limits } from "./api";

export const DEFAULT_LIMITS: Limits = { file: 25 * 1024 * 1024, total: 25 * 1024 * 1024, count: 20 };
export const PARALLEL = 3; // одновременных загрузок (столько принимает сервер)

// Исполняемые и опасные типы (тот же список, что на сервере)
const BLOCKED_EXT = new Set([
  "ade", "adp", "apk", "appx", "bat", "cab", "chm", "cmd", "com", "cpl", "dll", "dmg", "ex", "ex_", "exe", "hta", "ins", "isp",
  "iso", "jar", "js", "jse", "lib", "lnk", "mde", "msc", "msi", "msix", "msp", "mst", "nsh", "pif", "ps1", "scr", "sct", "sh",
  "shb", "sys", "vb", "vbe", "vbs", "vxd", "wsc", "wsf", "wsh",
]);

export type FileState = "waiting" | "uploading" | "done" | "error";

export interface AttItem {
  key: string; name: string; size: number; state: FileState; progress: number;
  blobId?: string; error?: string;
  keep?: boolean; // вложение пересылаемого письма (уже лежит на сервере, заново не загружается)
}

export const mb = (n: number): string => `${(n / 1024 / 1024).toFixed(n % (1024 * 1024) === 0 ? 0 : 1).replace(".", ",")} МБ`;

/** Сообщение, если файл такого типа нельзя отправлять, иначе null */
export function blockedName(name: string): string | null {
  const clean = name.replace(/[ .]+$/, "");
  const i = clean.lastIndexOf(".");
  const ext = i < 0 ? "" : clean.slice(i + 1).toLowerCase();
  return BLOCKED_EXT.has(ext) ? `Файлы типа .${ext} нельзя отправлять: они могут содержать программу.` : null;
}

/** Сколько байт уже занято вложениями (файлы с ошибкой не считаются) */
export const usedBytes = (items: AttItem[]): number => items.reduce((n, i) => (i.state === "error" ? n : n + i.size), 0);

/** Можно ли прикрепить файл к текущему списку: сообщение об отказе или null */
export function checkAdd(file: { name: string; size: number }, items: AttItem[], lim: Limits): string | null {
  const blocked = blockedName(file.name);
  if (blocked) return blocked;
  if (file.size === 0) return "Файл пустой.";
  if (file.size > lim.file) return `Файл больше ${mb(lim.file)}.`;
  if (items.filter((i) => i.state !== "error").length >= lim.count) return `Не больше ${lim.count} файлов в письме.`;
  if (usedBytes(items) + file.size > lim.total) return `Вложения не больше ${mb(lim.total)} в сумме.`;
  return null;
}

/** Что мешает отправить письмо прямо сейчас (null: ничего) */
export function sendBlocker(items: AttItem[]): string | null {
  if (items.some((i) => i.state === "waiting" || i.state === "uploading")) return "Дождитесь окончания загрузки файлов.";
  if (items.some((i) => i.state === "error")) return "Уберите файлы с ошибкой (они отмечены красным) или прикрепите их заново.";
  return null;
}
