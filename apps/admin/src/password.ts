// Хеширование пароля входа в админку: scrypt из стандартного модуля Node (без сторонних пакетов).
// Формат строки: scrypt$N$r$p$соль(base64)$хеш(base64)
import { randomBytes, randomInt, scrypt, timingSafeEqual } from "node:crypto";

const N = 16384, R = 8, P = 1, KEYLEN = 32;

function derive(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password.normalize("NFKC"), salt, KEYLEN, { N: n, r, p, maxmem: 64 * 1024 * 1024 }, (err, key) =>
      err ? reject(err) : resolve(key),
    ),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, N, R, P);
  return ["scrypt", N, R, P, salt.toString("base64"), key.toString("base64")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [n, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  if (![n, r, p].every((x) => Number.isInteger(x) && x > 0)) return false;
  try {
    const want = Buffer.from(parts[5], "base64");
    const got = await derive(password, Buffer.from(parts[4], "base64"), n, r, p);
    return want.length === got.length && timingSafeEqual(want, got);
  } catch {
    return false;
  }
}

// Случайный пароль для нового ящика: 32 символа без кавычек и обратных слэшей (удобно вставлять в формы)
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!#%+=?@_-";
export function generatePassword(length = 32): string {
  let out = "";
  for (let i = 0; i < length; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}
