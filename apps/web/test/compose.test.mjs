// Проверка логики ответов, пересылки и разбора адресов (compose.ts). Файл собирается rolldown во временную папку.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const out = mkdtempSync(join(tmpdir(), "dvmail-compose-"));
execFileSync("npx", ["rolldown", join(root, "src/compose.ts"), "--format", "esm", "--file", join(out, "compose.mjs")], { cwd: root, stdio: "pipe" });
const { buildDraft, parseAddresses, isDirty, emptyDraft, plainOf } = await import(pathToFileURL(join(out, "compose.mjs")).href);
process.on("exit", () => rmSync(out, { recursive: true, force: true }));

const A = (email, name = null) => ({ name, email });
const mail = (over = {}) => ({
  id: "e1", unread: false, mailboxIds: ["m1"], from: A("anna@example.org", "Анна"), to: [A("hello@dvbstudio.ru"), A("bob@example.org")],
  cc: [A("carl@example.org"), A("alias@dvbstudio.ru")], replyTo: [], subject: "Счёт", receivedAt: "2026-10-28T10:00:00Z", sentAt: "", size: 1,
  text: "Добрый день\nВторая строка", html: "", truncated: false, encrypted: false, attachments: [], ...over,
});
const OWN = ["hello@dvbstudio.ru", "alias@dvbstudio.ru"];

test("разбор адресов: имена, разделители, повторы, ошибки", () => {
  assert.deepEqual(parseAddresses("a@example.org, B@example.org; a@EXAMPLE.org\nc@example.org"), { ok: ["a@example.org", "B@example.org", "c@example.org"], bad: [] });
  assert.deepEqual(parseAddresses('"Иванов, Иван" <ivan@example.org>, Петр <petr@example.org>').ok, ["ivan@example.org", "petr@example.org"]);
  assert.deepEqual(parseAddresses("anna").bad, ["anna"], "слово без @ не должно молча пропадать");
  assert.deepEqual(parseAddresses("a@b, x@example.org").bad, ["a@b"]);
  assert.deepEqual(parseAddresses("  ,; ").ok, []);
  assert.deepEqual(parseAddresses("a b@example.org").bad, ["a"]); // пробел разделяет: «a» без @ будет показано как ошибка
});

test("ответ: адресат, тема, цитата", () => {
  const d = buildDraft("reply", mail(), OWN);
  assert.equal(d.to, "anna@example.org");
  assert.equal(d.cc, "");
  assert.equal(d.subject, "Re: Счёт");
  assert.equal(d.replyTo, "e1");
  assert.match(d.text, /^\n\n.*Анна <anna@example\.org> написал\(а\):\n> Добрый день\n> Вторая строка$/s);
  assert.equal(buildDraft("reply", mail({ subject: "Re: Счёт" }), OWN).subject, "Re: Счёт", "Re: не дублируется");
  assert.equal(buildDraft("reply", mail({ subject: "Ответ: Счёт" }), OWN).subject, "Ответ: Счёт");
  assert.equal(buildDraft("reply", mail({ subject: "" }), OWN).subject, "Re:");
});

test("ответ: Reply-To главнее отправителя", () => {
  assert.equal(buildDraft("reply", mail({ replyTo: [A("support@example.org")] }), OWN).to, "support@example.org");
});

test("ответ всем: свои адреса не попадают, повторов нет", () => {
  const d = buildDraft("replyAll", mail(), OWN);
  assert.equal(d.to, "anna@example.org, bob@example.org");
  assert.equal(d.cc, "carl@example.org");
  // письмо, которое написали сами себе: адресат остаётся
  const self = buildDraft("replyAll", mail({ from: A("hello@dvbstudio.ru"), to: [A("hello@dvbstudio.ru")], cc: [] }), OWN);
  assert.equal(self.to, "hello@dvbstudio.ru");
  // адрес в «Кому» и «Копия» одновременно показывается один раз
  const dup = buildDraft("replyAll", mail({ cc: [A("BOB@example.org")] }), OWN);
  assert.equal(dup.cc, "");
});

test("цитата не ломается от строк с «>» и от CRLF", () => {
  const d = buildDraft("reply", mail({ text: "> вложенная цитата\r\nобычная" }), OWN);
  assert.ok(d.text.endsWith(">> вложенная цитата\n> обычная"), d.text);
});

test("пересылка: пустые адресаты, шапка, тема Fwd:", () => {
  const d = buildDraft("forward", mail(), OWN);
  assert.equal(d.to, ""); assert.equal(d.replyTo, null);
  assert.equal(d.subject, "Fwd: Счёт");
  assert.match(d.text, /---------- Пересылаемое письмо ----------\nОт: Анна <anna@example\.org>\nДата: .+\nТема: Счёт\nКому: hello@dvbstudio\.ru, bob@example\.org\nКопия: .+\n\nДобрый день\nВторая строка$/s);
  assert.equal(buildDraft("forward", mail({ subject: "Fwd: Счёт" }), OWN).subject, "Fwd: Счёт");
});

test("зашифрованное письмо не цитируется", () => {
  assert.equal(plainOf(mail({ encrypted: true })), "");
  assert.doesNotMatch(buildDraft("reply", mail({ encrypted: true, text: "тайна" }), OWN).text, /тайна/);
});

test("изменения в окне письма замечаются", () => {
  const a = emptyDraft();
  assert.equal(isDirty(a, a), false);
  assert.equal(isDirty({ ...a, text: "x" }, a), true);
});
