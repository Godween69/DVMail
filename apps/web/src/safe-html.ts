// Подготовка письма к показу. Очистка HTML (DOMPurify) в браузере, затем ещё наши правила:
// ссылки делаем неактивными (их настоящие адреса показываем отдельным списком), внешние картинки не грузим.
// Результат кладётся в изолированное окно без скриптов, так что это вторая линия защиты, а не единственная.
import DOMPurify from "dompurify";

export interface LinkInfo {
  url: string;        // настоящий адрес ссылки
  host: string;       // сайт (для почты: адрес)
  kind: "web" | "mail";
  mismatch: boolean;  // текст ссылки выглядит как адрес другого сайта (приём фишинга)
  unusual: boolean;   // адрес с необычными символами (punycode)
}
export interface Prepared { html: string; links: LinkInfo[]; blockedImages: number }

const FORBID_TAGS = [
  "style", "script", "noscript", "template", "form", "input", "button", "textarea", "select", "option", "iframe", "frame",
  "frameset", "object", "embed", "link", "meta", "base", "svg", "math", "audio", "video", "source", "track", "canvas", "area", "map",
];
const FORBID_ATTR = ["srcset", "background", "action", "formaction", "ping", "poster", "target", "usemap", "xlink:href", "dynsrc", "lowsrc"];
const URLISH = /^(https?:\/\/)?([a-z0-9-]+\.)+[a-z]{2,}(:\d+)?(\/\S*)?$/i;
const DATA_IMG = /^data:image\/(png|jpe?g|gif|webp);base64,/i;

const bare = (h: string) => h.replace(/^www\./, "");
const sameSite = (a: string, b: string) => a === b || a.endsWith("." + b) || b.endsWith("." + a);

/** Разбирает ссылку; нестандартные виды (javascript:, data: и прочее) отбрасываются */
export function linkInfo(raw: string, shownText = ""): LinkInfo | null {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return null; }
  if (u.protocol === "mailto:") {
    const addr = decodeURIComponent(u.pathname).slice(0, 200);
    return addr ? { url: "mailto:" + addr, host: addr, kind: "mail", mismatch: false, unusual: false } : null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const host = u.hostname.toLowerCase();
  let mismatch = false;
  const t = shownText.trim();
  if (t && t.length <= 300 && URLISH.test(t)) { // длинный текст не проверяем (защита от долгого разбора)
    try { mismatch = !sameSite(bare(new URL(/^https?:/i.test(t) ? t : "https://" + t).hostname.toLowerCase()), bare(host)); } catch { /* текст не адрес */ }
  }
  return { url: u.href, host, kind: "web", mismatch, unusual: host.split(".").some((p) => p.startsWith("xn--")) };
}

/** Ссылки из обычного текста письма */
export function textLinks(text: string): LinkInfo[] {
  const out: LinkInfo[] = [], seen = new Set<string>();
  for (const m of text.matchAll(/https?:\/\/[^\s<>"'\])]+/gi)) {
    const l = linkInfo(m[0].replace(/[.,;:!?]+$/, ""));
    if (l && !seen.has(l.url)) { seen.add(l.url); out.push(l); }
    if (out.length >= 40) break;
  }
  return out;
}

// Встроенные стили в письмах не применятся (политика страницы их запрещает), а при разборе браузер пишет о них ошибки в консоль.
// Это только предварительная чистка; настоящая очистка делается ниже в DOMPurify.
const dropStyles = (h: string) =>
  h.replace(/<style\b[\s\S]*?<\/style\s*>/gi, "").replace(/\sstyle\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");

export function prepareHtml(dirty: string): Prepared {
  const frag = DOMPurify.sanitize(dropStyles(dirty), {
    RETURN_DOM_FRAGMENT: true, USE_PROFILES: { html: true }, ALLOW_DATA_ATTR: false, FORBID_TAGS, FORBID_ATTR,
  });
  const links: LinkInfo[] = [], seen = new Set<string>();
  for (const a of Array.from(frag.querySelectorAll("a"))) {
    const l = linkInfo(a.getAttribute("href") ?? "", a.textContent ?? "");
    if (l && !seen.has(l.url) && links.length < 40) { seen.add(l.url); links.push(l); }
    a.removeAttribute("href");  // ссылка в письме не кликается: адрес виден в списке под письмом
    a.removeAttribute("target");
  }
  // Адреса остаются только в списке под письмом: из самого письма ни одна ссылка не работает
  for (const el of Array.from(frag.querySelectorAll("[href]"))) el.removeAttribute("href");
  let blocked = 0;
  for (const img of Array.from(frag.querySelectorAll("img"))) {
    if (DATA_IMG.test(img.getAttribute("src") ?? "")) continue;
    blocked++;
    const stub = document.createElement("span");
    stub.className = "blocked";
    stub.textContent = img.getAttribute("alt")?.trim() || "изображение скрыто";
    img.replaceWith(stub);
  }
  const box = document.createElement("div");
  box.append(frag);
  return { html: box.innerHTML, links, blockedImages: blocked };
}

/** Страница для окна письма: стили подключены файлом (встроенные стили запрещены политикой) */
export const frameDoc = (body: string): string =>
  `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<meta name="referrer" content="no-referrer"><link rel="stylesheet" href="/frame.css"></head><body><div class="msg">${body}</div></body></html>`;
