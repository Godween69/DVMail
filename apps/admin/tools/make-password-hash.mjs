// Создаёт хеш пароля входа в админку и записывает его в файл (права 600). Сам пароль нигде не сохраняется.
// Запуск: node tools/make-password-hash.mjs ПУТЬ_К_ФАЙЛУ
// Пароль вводится скрыто, дважды. Формат хеша тот же, что проверяет сервер: scrypt$N$r$p$соль$хеш
import { randomBytes, scryptSync } from "node:crypto";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const out = process.argv[2];
if (!out) { console.error("Укажите путь к файлу для хеша."); process.exit(1); }
if (existsSync(out)) { console.error("Файл уже есть, не перезаписываю: " + out); process.exit(1); }

// Скрытый ввод с терминала; если ввод идёт не с терминала (конвейер), читаем две строки как есть
function readHidden(prompt) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) { resolve(null); return; }
    process.stdout.write(prompt);
    let buf = "";
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    const onData = (ch) => {
      for (const c of ch) {
        if (c === "\r" || c === "\n") {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.off("data", onData);
          process.stdout.write("\n");
          resolve(buf);
          return;
        }
        if (c === "\u0003") { process.stdout.write("\n"); process.exit(130); } // Ctrl-C
        if (c === "\u007f" || c === "\b") buf = [...buf].slice(0, -1).join("");
        else buf += c;
      }
    };
    process.stdin.on("data", onData);
  });
}

async function readPair() {
  const a = await readHidden("Пароль админки (ввод невидим): ");
  if (a !== null) return [a, await readHidden("Повторите пароль: ")];
  const lines = [];
  const rl = createInterface({ input: process.stdin });
  for await (const l of rl) { lines.push(l); if (lines.length === 2) break; }
  return lines;
}

const [p1, p2] = await readPair();
if (!p1 || p1.length < 12) { console.error("Пароль короче 12 символов. Ничего не записано."); process.exit(1); }
if (p1 !== p2) { console.error("Пароли не совпали. Ничего не записано."); process.exit(1); }

const salt = randomBytes(16);
const key = scryptSync(p1.normalize("NFKC"), salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
const line = ["scrypt", 16384, 8, 1, salt.toString("base64"), key.toString("base64")].join("$");
writeFileSync(out, line + "\n", { mode: 0o600 });
chmodSync(out, 0o600);
console.log("Хеш записан в " + out + " (права 600).");
