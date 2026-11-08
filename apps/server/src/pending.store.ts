import { Inject, Injectable, OnModuleDestroy } from "@nestjs/common";
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import { AppConfig, CONFIG } from "./config";

interface Pending {
  ticket: string;      // талон DV Auth: браузеру не отдаётся, он живёт только здесь
  email: string;
  accountId: string;
  iv: Buffer; ct: Buffer; tag: Buffer;   // пароль приложения, зашифрованный ключом из куки браузера
  created: number;
}

export interface PendingLogin { ticket: string; email: string; accountId: string; password: string }

// Вход между шагами «пароль» и «второй фактор». Пока человек подтверждает вход, сессии ещё нет, а пароль приложения
// нужен, чтобы её открыть. Поэтому он ждёт здесь, в памяти, зашифрованный AES-256-GCM ключом, который есть только в
// короткоживущей куке этого браузера (так же устроены обычные сессии). Талон DV Auth браузеру не отдаётся:
// второй шаг без этой куки невозможен, а кража талона ничего не даёт.
@Injectable()
export class PendingStore implements OnModuleDestroy {
  private readonly map = new Map<string, Pending>();
  private readonly timer: NodeJS.Timeout;

  constructor(@Inject(CONFIG) private readonly cfg: AppConfig) {
    this.timer = setInterval(() => this.sweep(), 30_000);
    this.timer.unref();
  }

  onModuleDestroy(): void { clearInterval(this.timer); this.map.clear(); }

  private lookup(token: string): string { return createHash("sha256").update(token).digest("hex"); }
  private key(token: string): Buffer {
    return Buffer.from(hkdfSync("sha256", Buffer.from(token, "base64url"), Buffer.alloc(0), "dvmail-pending-v1", 32));
  }

  create(p: PendingLogin): string {
    // Не больше 500 ожидающих входов: старые уходят, память не раздувается
    while (this.map.size >= 500) this.map.delete(this.map.keys().next().value as string);
    const token = randomBytes(32).toString("base64url");
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key(token), iv);
    const ct = Buffer.concat([c.update(p.password, "utf8"), c.final()]);
    this.map.set(this.lookup(token), { ticket: p.ticket, email: p.email, accountId: p.accountId, iv, ct, tag: c.getAuthTag(), created: Date.now() });
    return token;
  }

  get(token: string | undefined): PendingLogin | null {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const k = this.lookup(token);
    const s = this.map.get(k);
    if (!s) return null;
    if (Date.now() - s.created > this.cfg.pendingMs) { this.map.delete(k); return null; }
    try {
      const d = createDecipheriv("aes-256-gcm", this.key(token), s.iv);
      d.setAuthTag(s.tag);
      const password = Buffer.concat([d.update(s.ct), d.final()]).toString("utf8");
      return { ticket: s.ticket, email: s.email, accountId: s.accountId, password };
    } catch { this.map.delete(k); return null; }
  }

  destroy(token: string | undefined): void { if (token) this.map.delete(this.lookup(token)); }

  private sweep(): void {
    const now = Date.now();
    for (const [k, s] of this.map) if (now - s.created > this.cfg.pendingMs) this.map.delete(k);
  }
}
