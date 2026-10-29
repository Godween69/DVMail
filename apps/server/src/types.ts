import type { Request } from "express";

// Данные открытой сессии (пароль приложения живёт только в памяти сервера, в зашифрованном виде)
export interface SessionInfo {
  email: string;
  accountId: string;
  password: string;
}

export type SessionRequest = Request & { dvSession: SessionInfo; dvToken: string };
