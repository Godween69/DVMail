// Проверка правил вложений на странице (attachments.ts): типы, размеры, очередь ограничений. Файл собирается rolldown во временную папку.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const out = mkdtempSync(join(tmpdir(), "dvmail-attach-"));
execFileSync("npx", ["rolldown", join(root, "src/attachments.ts"), "--format", "esm", "--file", join(out, "attachments.mjs")], { cwd: root, stdio: "pipe" });
const { blockedName, checkAdd, sendBlocker, usedBytes, mb, DEFAULT_LIMITS } = await import(pathToFileURL(join(out, "attachments.mjs")).href);
process.on("exit", () => rmSync(out, { recursive: true, force: true }));

const MB = 1024 * 1024;
const it = (over = {}) => ({ key: "k", name: "a.pdf", size: 1000, state: "done", progress: 1, ...over });

test("исполняемые типы запрещены, регистр и хвостовые точки не помогают", () => {
  for (const n of ["setup.exe", "RUN.BAT", "x.Js", "tool.sh", "a.exe ", "b.exe.", "archive.msi", "photo.png.scr"]) assert.ok(blockedName(n), n);
  for (const n of ["счёт.pdf", "фото.png", "readme", "data.json", "exe", "my.exe.txt", "архив.zip"]) assert.equal(blockedName(n), null, n);
});

test("размеры: пустой, больше предела, сумма, число файлов", () => {
  const lim = { file: 10 * MB, total: 12 * MB, count: 3 };
  assert.equal(checkAdd({ name: "a.pdf", size: 5 * MB }, [], lim), null);
  assert.match(checkAdd({ name: "a.pdf", size: 0 }, [], lim), /пустой/);
  assert.match(checkAdd({ name: "a.pdf", size: 11 * MB }, [], lim), /больше 10 МБ/);
  assert.match(checkAdd({ name: "b.pdf", size: 8 * MB }, [it({ size: 5 * MB })], lim), /в сумме/);
  assert.match(checkAdd({ name: "x.exe", size: 10 }, [], lim), /нельзя отправлять/);
  const three = [it(), it(), it()];
  assert.match(checkAdd({ name: "d.pdf", size: 1 }, three, lim), /Не больше 3/);
  // файлы с ошибкой не занимают ни место, ни счёт
  const errs = [it({ state: "error", size: 20 * MB }), it({ state: "error" }), it({ state: "error" }), it({ state: "error" })];
  assert.equal(checkAdd({ name: "d.pdf", size: 1 }, errs, lim), null);
  assert.equal(usedBytes([it({ size: 5 }), it({ state: "error", size: 100 }), it({ state: "uploading", size: 7 })]), 12);
});

test("отправка заблокирована, пока файлы грузятся или есть ошибка", () => {
  assert.equal(sendBlocker([]), null);
  assert.equal(sendBlocker([it(), it({ keep: true })]), null);
  assert.match(sendBlocker([it(), it({ state: "uploading" })]), /Дождитесь/);
  assert.match(sendBlocker([it({ state: "waiting" })]), /Дождитесь/);
  assert.match(sendBlocker([it({ state: "error" })]), /Уберите/);
});

test("размер в мегабайтах и предел по умолчанию", () => {
  assert.equal(mb(25 * MB), "25 МБ");
  assert.equal(mb(1.5 * MB), "1,5 МБ");
  assert.deepEqual(DEFAULT_LIMITS, { file: 25 * MB, total: 25 * MB, count: 20 });
});
