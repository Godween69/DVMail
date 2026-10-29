import { Inject, Injectable } from "@nestjs/common";
import { AdminConfig, CONFIG } from "./config";

// Считает неудачные входы в окне времени: отдельно по адресу и в целом (пользователь у админки один,
// поэтому общий счётчик не даёт перебирать пароль, меняя адрес).
@Injectable()
export class LoginLimiter {
  private readonly fails = new Map<string, number[]>();

  constructor(@Inject(CONFIG) private readonly cfg: AdminConfig) {}

  private recent(key: string, now: number): number[] {
    const list = (this.fails.get(key) ?? []).filter((t) => now - t < this.cfg.failWindowMs);
    if (list.length) this.fails.set(key, list);
    else this.fails.delete(key);
    return list;
  }

  /** Сколько секунд ждать до следующей попытки (0: можно пробовать) */
  waitSeconds(ip: string): number {
    const now = Date.now();
    let wait = 0;
    const checks: Array<[string, number]> = [
      [`ip:${ip}`, this.cfg.maxFailPerIp],
      ["all", this.cfg.maxFailTotal],
    ];
    for (const [key, max] of checks) {
      const list = this.recent(key, now);
      if (list.length >= max) {
        wait = Math.max(wait, Math.ceil((list[list.length - max] + this.cfg.failWindowMs - now) / 1000));
      }
    }
    return wait;
  }

  fail(ip: string): void {
    const now = Date.now();
    if (this.fails.size > 1000) this.fails.clear(); // защита от раздувания памяти
    for (const key of [`ip:${ip}`, "all"]) this.fails.set(key, [...this.recent(key, now), now]);
  }

  ok(ip: string): void {
    this.fails.delete(`ip:${ip}`);
  }
}
