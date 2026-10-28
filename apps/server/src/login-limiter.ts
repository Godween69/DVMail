import { Inject, Injectable } from "@nestjs/common";
import { AppConfig, CONFIG } from "./config";

// Считает неудачные входы в окне времени: отдельно по паре «сеть + почта» и по сети в целом.
// Это второй слой после автобана самого Stalwart.
@Injectable()
export class LoginLimiter {
  private readonly fails = new Map<string, number[]>();

  constructor(@Inject(CONFIG) private readonly cfg: AppConfig) {}

  private recent(key: string, now: number): number[] {
    const list = (this.fails.get(key) ?? []).filter((t) => now - t < this.cfg.failWindowMs);
    if (list.length) this.fails.set(key, list);
    else this.fails.delete(key);
    return list;
  }

  /** Сколько секунд ждать до следующей попытки (0: можно пробовать) */
  waitSeconds(ip: string, email: string): number {
    const now = Date.now();
    let wait = 0;
    const checks: Array<[string, number]> = [
      [`ip:${ip}`, this.cfg.maxFailPerIp],
      [`pair:${ip}|${email}`, this.cfg.maxFailPerPair],
    ];
    for (const [key, max] of checks) {
      const list = this.recent(key, now);
      if (list.length >= max) {
        wait = Math.max(wait, Math.ceil((list[list.length - max] + this.cfg.failWindowMs - now) / 1000));
      }
    }
    return wait;
  }

  fail(ip: string, email: string): void {
    const now = Date.now();
    if (this.fails.size > 10_000) this.fails.clear(); // защита от раздувания памяти
    for (const key of [`ip:${ip}`, `pair:${ip}|${email}`]) {
      this.fails.set(key, [...this.recent(key, now), now]);
    }
  }

  ok(ip: string, email: string): void {
    this.fails.delete(`pair:${ip}|${email}`);
  }
}
