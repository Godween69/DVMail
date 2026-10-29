import { Inject, Injectable, OnModuleDestroy } from "@nestjs/common";
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import { AppConfig, CONFIG } from "./config";
import type { SessionInfo } from "./types";

interface Stored {
  iv: Buffer;
  ct: Buffer;
  tag: Buffer;
  email: string;
  accountId: string;
  created: number;
  seen: number;
  hits: number[];   // время последних запросов (для ограничения частоты)
}

// Идея: в cookie лежит случайный токен (32 байта). На сервере хранится только его хеш (для поиска)
// и пароль приложения, зашифрованный AES-256-GCM ключом, выведенным из токена.
// Сам токен на сервере не хранится: по дампу памяти пароль не прочесть. Перезапуск сервера сбрасывает все сессии.
@Injectable()
export class SessionStore implements OnModuleDestroy {
  private readonly map = new Map<string, Stored>();
  private readonly timer: NodeJS.Timeout;

  constructor(@Inject(CONFIG) private readonly cfg: AppConfig) {
    this.timer = setInterval(() => this.sweep(), 60_000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
    this.map.clear();
  }

  private lookupKey(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }

  private aesKey(token: string): Buffer {
    return Buffer.from(hkdfSync("sha256", Buffer.from(token, "base64url"), Buffer.alloc(0), "dvmail-session-v1", 32));
  }

  private evictOldest(match: (s: Stored) => boolean, limit: number): void {
    const list = [...this.map.entries()].filter(([, s]) => match(s));
    if (list.length < limit) return;
    list.sort((a, b) => a[1].created - b[1].created);
    for (const [k] of list.slice(0, list.length - limit + 1)) this.map.delete(k);
  }

  /** Ограничение частоты запросов одной сессии. Возвращает, сколько секунд подождать (0: можно). */
  throttle(token: string | undefined): number {
    const s = token ? this.map.get(this.lookupKey(token)) : undefined;
    if (!s) return 0;
    const now = Date.now();
    s.hits = s.hits.filter((t) => now - t < 60_000);
    if (s.hits.length >= this.cfg.maxRequestsPerMinute) return Math.max(1, Math.ceil((s.hits[0] + 60_000 - now) / 1000));
    s.hits.push(now);
    return 0;
  }

  create(info: SessionInfo): string {
    // Не больше 8 открытых сессий на ящик и 2000 в целом: старые закрываются, память не раздувается
    this.evictOldest((s) => s.email === info.email, 8);
    this.evictOldest(() => true, 2000);
    const token = randomBytes(32).toString("base64url");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.aesKey(token), iv);
    const ct = Buffer.concat([cipher.update(info.password, "utf8"), cipher.final()]);
    const now = Date.now();
    this.map.set(this.lookupKey(token), {
      iv, ct, tag: cipher.getAuthTag(), email: info.email, accountId: info.accountId, created: now, seen: now, hits: [],
    });
    return token;
  }

  get(token: string | undefined): SessionInfo | null {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const key = this.lookupKey(token);
    const s = this.map.get(key);
    if (!s) return null;
    const now = Date.now();
    if (now - s.seen > this.cfg.idleMs || now - s.created > this.cfg.absoluteMs) {
      this.map.delete(key);
      return null;
    }
    try {
      const d = createDecipheriv("aes-256-gcm", this.aesKey(token), s.iv);
      d.setAuthTag(s.tag);
      const password = Buffer.concat([d.update(s.ct), d.final()]).toString("utf8");
      s.seen = now;
      return { email: s.email, accountId: s.accountId, password };
    } catch {
      this.map.delete(key);
      return null;
    }
  }

  destroy(token: string | undefined): void {
    if (token) this.map.delete(this.lookupKey(token));
  }

  private sweep(): void {
    const now = Date.now();
    for (const [k, s] of this.map) {
      if (now - s.seen > this.cfg.idleMs || now - s.created > this.cfg.absoluteMs) this.map.delete(k);
    }
  }
}
