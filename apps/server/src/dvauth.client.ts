import { HttpException, Inject, Injectable } from "@nestjs/common";
import { AppConfig, CONFIG } from "./config";

export interface FactorStatus {
  enabled: boolean;
  chatAvailable: boolean;
  chatLinked: boolean;
  matrixId: string | null;
  totpAvailable: boolean;
  totpEnabled: boolean;
  recoveryLeft: number;
  methods: string[];
}

export interface ChatChallenge {
  challenge: string;
  number: string;
  qr: string;
  expiresIn: number;
}

const DOWN = "Сервис второго фактора сейчас недоступен. Попробуйте позже.";

// Клиент DV Auth (отдельный сервис второго фактора, github.com/Godween69/DVAuth).
// Если он настроен, но не отвечает или не принимает секрет, вход закрыт (503): «не знаю, включён ли второй
// фактор» нельзя считать «не включён». Настоящий адрес человека (ip) передаётся всегда: по нему считается блокировка.
@Injectable()
export class DvAuthClient {
  constructor(@Inject(CONFIG) private readonly cfg: AppConfig) {}

  get enabled(): boolean {
    return this.cfg.authUrl !== "";
  }

  async call<T>(method: "GET" | "POST", path: string, body?: Record<string, unknown>): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.cfg.authUrl + path, {
        method, redirect: "manual",
        headers: { authorization: `Bearer ${this.cfg.authSecret}`, ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(8000),
      });
    } catch {
      throw new HttpException({ message: DOWN }, 503);
    }
    let json: { error?: string; message?: string } & Record<string, unknown> = {};
    try { json = (await res.json()) as typeof json; } catch { /* ответ не JSON */ }
    if (res.ok) return json as T;
    // Неверный секрет приложения и внутренние ошибки наружу как «неверный код» не показываем: вины человека тут нет.
    // Перенаправление (3xx) тоже считаем сбоем настройки: сами никуда не переходим.
    const broken = res.status >= 500 || (res.status >= 300 && res.status < 400) || (res.status === 401 && json.error === "unauthorized");
    if (broken) throw new HttpException({ message: DOWN }, 503);
    throw new HttpException({ message: typeof json.message === "string" ? json.message : "Ошибка второго фактора", code: json.error }, res.status);
  }

  status(subject: string): Promise<FactorStatus> {
    return this.call("GET", `/v1/status?subject=${encodeURIComponent(subject)}`);
  }
}
