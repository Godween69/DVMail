// Разбор заголовка Cookie и сборка Set-Cookie (HttpOnly, SameSite=Strict)
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

// Secure не ставим: админка открывается по http на локальном адресе (через туннель). Наружу она не публикуется.
export function buildCookie(name: string, value: string, maxAgeSec: number): string {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}`;
}
