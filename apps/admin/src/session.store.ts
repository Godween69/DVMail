import { Inject, Injectable, OnModuleDestroy } from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import { AdminConfig, CONFIG } from "./config";

interface Stored {
  created: number;
  seen: number;
}

// В cookie лежит случайный токен (32 байта). На сервере хранится только его хеш, а не сам токен.
// Перезапуск админки сбрасывает все сессии.
@Injectable()
export class SessionStore implements OnModuleDestroy {
  private readonly map = new Map<string, Stored>();
  private readonly timer: NodeJS.Timeout;

  constructor(@Inject(CONFIG) private readonly cfg: AdminConfig) {
    this.timer = setInterval(() => this.sweep(), 60_000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
    this.map.clear();
  }

  private key(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }

  create(): string {
    const token = randomBytes(32).toString("base64url");
    const now = Date.now();
    this.map.set(this.key(token), { created: now, seen: now });
    return token;
  }

  valid(token: string | undefined): boolean {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
    const k = this.key(token);
    const s = this.map.get(k);
    if (!s) return false;
    const now = Date.now();
    if (now - s.seen > this.cfg.idleMs || now - s.created > this.cfg.absoluteMs) {
      this.map.delete(k);
      return false;
    }
    s.seen = now;
    return true;
  }

  destroy(token: string | undefined): void {
    if (token) this.map.delete(this.key(token));
  }

  private sweep(): void {
    const now = Date.now();
    for (const [k, s] of this.map) {
      if (now - s.seen > this.cfg.idleMs || now - s.created > this.cfg.absoluteMs) this.map.delete(k);
    }
  }
}
